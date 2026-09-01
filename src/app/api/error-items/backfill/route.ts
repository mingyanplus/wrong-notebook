import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getAIService } from "@/lib/ai";
import { findParentTagIdForGrade } from "@/lib/tag-recognition";
import { inferSubjectFromName } from "@/lib/knowledge-tags";

const logger = createLogger('api:error-items:backfill');

const MAX_BATCH = 20;

/**
 * 批量补全错题元数据（B4：标签 + 题型 + 错因）
 * POST /api/error-items/backfill  body: { ids?: string[] }
 * 不传 ids 时自动挑选缺失元数据的错题（最多 MAX_BATCH 条）
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    try {
        const userId = session.user.id;
        const body = await req.json().catch(() => ({}));
        const ids: string[] | undefined = Array.isArray(body?.ids) ? body.ids : undefined;

        // 选出待补全的错题
        let targets;
        if (ids && ids.length > 0) {
            targets = await prisma.errorItem.findMany({
                where: { id: { in: ids.slice(0, MAX_BATCH) }, userId },
                include: { tags: true, subject: true },
            });
        } else {
            targets = await prisma.errorItem.findMany({
                where: {
                    userId,
                    OR: [
                        { errorCategory: null },
                        { questionType: null },
                        { tags: { none: {} } },
                    ],
                },
                include: { tags: true, subject: true },
                orderBy: { createdAt: 'desc' },
                take: MAX_BATCH,
            });
        }

        const aiService = getAIService();
        const failed: Array<{ id: string; reason: string }> = [];
        let updated = 0;

        for (const item of targets) {
            if (!item.questionText?.trim()) {
                failed.push({ id: item.id, reason: "无题干文本" });
                continue;
            }

            try {
                const meta = await aiService.backfillMeta(
                    item.questionText,
                    item.answerText || undefined,
                    item.analysis || undefined,
                    item.wrongAnswerText || undefined,
                    item.subject?.name || null
                );

                const data: Record<string, unknown> = {};
                // unknown 不覆盖已有判定
                if (meta.errorCategory && meta.errorCategory !== "unknown") {
                    data.errorCategory = meta.errorCategory;
                    if (meta.secondaryErrorCategories.length > 0) {
                        data.secondaryErrorCategories = JSON.stringify(meta.secondaryErrorCategories);
                    }
                }
                if (meta.questionType && !item.questionType) {
                    data.questionType = meta.questionType;
                }

                // 标签补全（仅当当前无标签）
                if (item.tags.length === 0 && meta.knowledgePoints.length > 0) {
                    const subjectKey = inferSubjectFromName(item.subject?.name ?? null) ?? 'other';

                    // 批量查已有标签；父级标签对同一题是常量，只查一次
                    const existingTags = await prisma.knowledgeTag.findMany({
                        where: { name: { in: meta.knowledgePoints }, OR: [{ isSystem: true }, { userId }] },
                    });
                    const existingByName = new Map(existingTags.map((tg) => [tg.name, tg]));
                    const parentId = await findParentTagIdForGrade(item.gradeSemester, subjectKey);

                    const tagIds: string[] = [];
                    for (const tagName of meta.knowledgePoints) {
                        let tag = existingByName.get(tagName);
                        if (!tag) {
                            tag = await prisma.knowledgeTag.create({
                                data: { name: tagName, subject: subjectKey, parentId: parentId ?? undefined, isSystem: false, userId },
                            });
                        }
                        tagIds.push(tag.id);
                    }
                    data.tags = { connect: tagIds.map((id) => ({ id })) };
                    data.knowledgePoints = JSON.stringify(meta.knowledgePoints);
                }

                if (Object.keys(data).length > 0) {
                    await prisma.errorItem.update({ where: { id: item.id }, data });
                    updated += 1;
                }
            } catch (error) {
                logger.warn({ error, itemId: item.id }, 'Backfill failed for item');
                failed.push({ id: item.id, reason: error instanceof Error ? error.message : String(error) });
            }
        }

        logger.info({ total: targets.length, updated, failedCount: failed.length }, 'Backfill batch complete');
        return NextResponse.json({ processed: targets.length, updated, failed });
    } catch (error) {
        logger.error({ error }, 'Error running backfill');
        return internalError("Failed to run backfill");
    }
}
