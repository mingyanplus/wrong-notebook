import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { advanceReviewSchedule } from "@/lib/scheduler";

const logger = createLogger('api:review:complete');

/**
 * 复习结果录入（纸质复习卷闭环）：逐题对/错 → 完成当前复习计划 + 掌握度升降 +
 * PracticeRecord + 艾宾浩斯下一条计划（事务内执行，复用 paper grade 的同一推进实现）。
 * POST /api/review/complete  body: { results: [{ errorItemId, isCorrect }] }
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    try {
        const userId = session.user.id;
        const { results } = (await req.json()) as { results?: Array<{ errorItemId?: unknown; isCorrect?: unknown }> };

        if (!Array.isArray(results) || results.length === 0) {
            return badRequest("results is required");
        }

        // 只接受本用户名下的错题（防止跨用户推进他人复习计划）
        const requestedIds = Array.from(
            new Set(results.filter((r) => typeof r?.errorItemId === "string").map((r) => r.errorItemId as string))
        );
        const owned = await prisma.errorItem.findMany({
            where: { id: { in: requestedIds }, userId },
            select: { id: true, subject: { select: { name: true } } },
        });
        const ownedById = new Map(owned.map((o) => [o.id, o]));

        // 同一错题多次出现以最后一次为准
        const lastResultByItem = new Map<string, boolean>();
        for (const r of results) {
            if (typeof r?.errorItemId === "string" && ownedById.has(r.errorItemId)) {
                lastResultByItem.set(r.errorItemId, !!r.isCorrect);
            }
        }
        if (lastResultByItem.size === 0) {
            return badRequest("No valid results");
        }

        await prisma.$transaction(async (tx) => {
            for (const [itemId, isCorrect] of lastResultByItem) {
                await advanceReviewSchedule(itemId, isCorrect, tx);
            }
            await tx.practiceRecord.createMany({
                data: Array.from(lastResultByItem.entries()).map(([itemId, isCorrect]) => ({
                    userId,
                    subject: ownedById.get(itemId)?.subject?.name || null,
                    isCorrect,
                })),
            });
        });

        logger.info({ resultsCount: lastResultByItem.size }, 'Review results recorded');
        return NextResponse.json({ ok: true, updatedItems: lastResultByItem.size });
    } catch (error) {
        logger.error({ error }, 'Error recording review results');
        return internalError("Failed to record review results");
    }
}
