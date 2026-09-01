import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, notFound } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { calculateNextReviewDate } from "@/lib/scheduler";

const logger = createLogger('api:practice:record');

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    try {
        const { subject, difficulty, isCorrect, errorItemId } = await req.json();

        const userId = session.user.id;

        const record = await prisma.practiceRecord.create({
            data: {
                userId,
                subject,
                difficulty,
                isCorrect,
            },
        });

        // 关联错题时，回写掌握度并推进艾宾浩斯复习计划
        if (errorItemId) {
            const errorItem = await prisma.errorItem.findUnique({
                where: { id: errorItemId },
                select: { userId: true },
            });

            if (!errorItem) {
                return notFound("Item not found");
            }

            if (errorItem.userId !== userId) {
                return NextResponse.json({ message: "Not authorized" }, { status: 403 });
            }

            // 完成当前待复习的记录（若存在）
            const activeSchedule = await prisma.reviewSchedule.findFirst({
                where: { errorItemId, completedAt: null },
                orderBy: { scheduledFor: 'asc' },
            });

            if (activeSchedule) {
                await prisma.reviewSchedule.update({
                    where: { id: activeSchedule.id },
                    data: { completedAt: new Date(), isCorrect: !!isCorrect },
                });
            }

            // 答对：掌握度升一级（封顶 2），复习次数 +1；答错：重置为第 0 阶段
            const currentCount = activeSchedule?.reviewCount ?? 0;
            const nextCount = isCorrect ? currentCount + 1 : 0;

            const item = await prisma.errorItem.findUnique({
                where: { id: errorItemId },
                select: { masteryLevel: true },
            });
            const nextMastery = isCorrect
                ? Math.min((item?.masteryLevel ?? 0) + 1, 2)
                : 0;

            await prisma.errorItem.update({
                where: { id: errorItemId },
                data: { masteryLevel: nextMastery },
            });

            await prisma.reviewSchedule.create({
                data: {
                    errorItemId,
                    scheduledFor: calculateNextReviewDate(nextCount),
                    reviewCount: nextCount,
                },
            });

            logger.info({ errorItemId, isCorrect, nextCount }, 'Review schedule advanced');
        }

        return NextResponse.json(record);
    } catch (error) {
        logger.error({ error }, 'Error saving practice record');
        return internalError("Failed to save record");
    }
}
