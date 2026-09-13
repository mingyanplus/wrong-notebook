import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { parseImageMasks } from "@/lib/image-masks";
import { parseLegacyKnowledgePoints } from "@/lib/knowledge-tags";
import { parseReviewSettings, MAX_DAILY_LIMIT } from "@/lib/review-settings";

const logger = createLogger('api:review:due');

/** 复习数量安全上限（用户设置 dailyLimit=null 即不限时兜底，防一次拉爆） */
const HARD_LIMIT = MAX_DAILY_LIMIT;

/**
 * 获取当前用户到期待复习的错题列表（艾宾浩斯计划）
 * 应用用户复习设置：勾选的错因类型过滤 + 每日数量上限；排序为掌握度低优先、到期早优先
 * GET /api/review/due?subjectId=xxx
 */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    try {
        const userId = session.user.id;
        const { searchParams } = new URL(req.url);
        const subjectId = searchParams.get("subjectId");
        // 原图是 base64 大字段：仅打印场景（include=image）拉取，横幅列表（只用题干/标签）不拉
        const includeImage = searchParams.get("include") === "image";

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { reviewSettings: true },
        });
        const settings = parseReviewSettings(user?.reviewSettings);

        const schedules = await prisma.reviewSchedule.findMany({
            where: {
                completedAt: null,
                scheduledFor: { lte: new Date() },
                errorItem: {
                    userId,
                    ...(subjectId ? { subjectId } : {}),
                    // 重点复习：勾选了错因类型时，只看这些错因的题（如"做不来"=stuck/method）
                    ...(settings.errorCategories ? { errorCategory: { in: settings.errorCategories } } : {}),
                },
            },
            orderBy: [{ errorItem: { masteryLevel: 'asc' } }, { scheduledFor: 'asc' }],
            include: {
                errorItem: {
                    select: {
                        id: true,
                        questionText: true,
                        ...(includeImage
                            ? { originalImageUrl: true, imageMasks: true } // 复习卷打印用（去红 + 遮罩）
                            : {}),
                        knowledgePoints: true, // 老数据回退用（tags 为空时）
                        tags: { select: { name: true } },
                    },
                },
            },
            take: settings.dailyLimit ?? HARD_LIMIT,
        });

        const items = schedules.map((s) => ({
            scheduleId: s.id,
            overdueDays: Math.max(
                0,
                Math.floor((Date.now() - s.scheduledFor.getTime()) / 86400000)
            ),
            errorItem: {
                id: s.errorItem.id,
                questionText: s.errorItem.questionText,
                ...(includeImage
                    ? {
                          originalImageUrl: s.errorItem.originalImageUrl,
                          imageMasks: parseImageMasks(s.errorItem.imageMasks),
                      }
                    : {}),
                // 知识点标签优先，老数据回退 knowledgePoints JSON（与错题列表口径一致）
                knowledgeTags:
                    s.errorItem.tags.length > 0
                        ? s.errorItem.tags.map((t) => t.name)
                        : parseLegacyKnowledgePoints(s.errorItem.knowledgePoints),
            },
        }));

        return NextResponse.json({ count: items.length, items });
    } catch (error) {
        logger.error({ error }, 'Error fetching due reviews');
        return internalError("Failed to fetch due reviews");
    }
}
