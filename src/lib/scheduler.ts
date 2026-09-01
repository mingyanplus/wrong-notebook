import { addDays } from "date-fns";
import { prisma } from "./prisma";
import type { Prisma } from "@prisma/client";

// Ebbinghaus base intervals in days: 1, 2, 4, 7, 15, 30
const BASE_REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30];
// After the base stages, each interval grows by this factor, capped at MAX_INTERVAL_DAYS
const EXTENDED_GROWTH_FACTOR = 1.5;
const MAX_INTERVAL_DAYS = 90;

export function getReviewIntervalDays(reviewCount: number): number {
    if (reviewCount < BASE_REVIEW_INTERVALS.length) {
        return BASE_REVIEW_INTERVALS[reviewCount];
    }
    // Beyond the base stages: 30 × 1.5^(n), capped at 90 days
    const exponent = reviewCount - BASE_REVIEW_INTERVALS.length + 1;
    return Math.min(Math.round(30 * Math.pow(EXTENDED_GROWTH_FACTOR, exponent)), MAX_INTERVAL_DAYS);
}

export function calculateNextReviewDate(reviewCount: number): Date {
    return addDays(new Date(), getReviewIntervalDays(reviewCount));
}

// ── 复习推进（艾宾浩斯 + 掌握度迁移的单一实现，供 practice/record 与 paper grade 共用）──

/** 掌握度迁移：答对升一级（封顶 2），答错重置 0 */
export function nextMasteryLevel(current: number, isCorrect: boolean): number {
    return isCorrect ? Math.min(current + 1, 2) : 0;
}

/**
 * 推进一道错题的复习计划：完成当前未完成的计划 → 迁移掌握度 → 创建下一条计划。
 * @returns 更新后的掌握度；错题不存在时返回 null
 */
export async function advanceReviewSchedule(
    errorItemId: string,
    isCorrect: boolean,
    tx?: Prisma.TransactionClient
): Promise<number | null> {
    const db = tx ?? prisma;

    const activeSchedule = await db.reviewSchedule.findFirst({
        where: { errorItemId, completedAt: null },
        orderBy: { scheduledFor: "asc" },
    });

    if (activeSchedule) {
        await db.reviewSchedule.update({
            where: { id: activeSchedule.id },
            data: { completedAt: new Date(), isCorrect },
        });
    }

    const currentCount = activeSchedule?.reviewCount ?? 0;
    const nextCount = isCorrect ? currentCount + 1 : 0;

    const item = await db.errorItem.findUnique({
        where: { id: errorItemId },
        select: { masteryLevel: true },
    });
    if (!item) return null;

    const mastery = nextMasteryLevel(item.masteryLevel ?? 0, isCorrect);
    await db.errorItem.update({
        where: { id: errorItemId },
        data: { masteryLevel: mastery },
    });

    await db.reviewSchedule.create({
        data: {
            errorItemId,
            scheduledFor: calculateNextReviewDate(nextCount),
            reviewCount: nextCount,
        },
    });

    return mastery;
}
