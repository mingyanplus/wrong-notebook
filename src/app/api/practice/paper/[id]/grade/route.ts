import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, notFound, forbidden, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { calculateNextReviewDate } from "@/lib/scheduler";

const logger = createLogger('api:practice:paper:grade');

/**
 * 录成绩（纸质卷闭环断点）：逐题对/错 → 回写试卷题目结果 +
 * 掌握度升降 + PracticeRecord + 艾宾浩斯复习计划推进
 */
export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    try {
        const userId = session.user.id;
        const { results } = await req.json(); // [{ questionId, isCorrect }]

        if (!Array.isArray(results) || results.length === 0) {
            return badRequest("results is required");
        }

        const paper = await prisma.practicePaper.findUnique({
            where: { id },
            include: { questions: true },
        });
        const subject = paper?.subjectId ? await prisma.subject.findUnique({ where: { id: paper.subjectId }, select: { name: true } }) : null;

        if (!paper) {
            return notFound("Paper not found");
        }
        if (paper.userId !== userId) {
            return forbidden("Not authorized");
        }

        const questionMap = new Map(paper.questions.map((q) => [q.id, q]));
        let updatedItems = 0;

        for (const r of results) {
            const q = questionMap.get(r.questionId);
            if (!q) continue;

            await prisma.paperQuestion.update({
                where: { id: q.id },
                data: { isCorrect: !!r.isCorrect },
            });

            // 回写原错题：掌握度 + 练习记录 + 复习计划
            if (q.sourceErrorItemId) {
                const activeSchedule = await prisma.reviewSchedule.findFirst({
                    where: { errorItemId: q.sourceErrorItemId, completedAt: null },
                    orderBy: { scheduledFor: "asc" },
                });
                if (activeSchedule) {
                    await prisma.reviewSchedule.update({
                        where: { id: activeSchedule.id },
                        data: { completedAt: new Date(), isCorrect: !!r.isCorrect },
                    });
                }

                const currentCount = activeSchedule?.reviewCount ?? 0;
                const nextCount = r.isCorrect ? currentCount + 1 : 0;

                const item = await prisma.errorItem.findUnique({
                    where: { id: q.sourceErrorItemId },
                    select: { masteryLevel: true },
                });
                if (item) {
                    const nextMastery = r.isCorrect
                        ? Math.min((item.masteryLevel ?? 0) + 1, 2)
                        : 0;
                    await prisma.errorItem.update({
                        where: { id: q.sourceErrorItemId },
                        data: { masteryLevel: nextMastery },
                    });
                }

                await prisma.reviewSchedule.create({
                    data: {
                        errorItemId: q.sourceErrorItemId,
                        scheduledFor: calculateNextReviewDate(nextCount),
                        reviewCount: nextCount,
                    },
                });

                await prisma.practiceRecord.create({
                    data: {
                        userId,
                        subject: subject?.name || null,
                        isCorrect: !!r.isCorrect,
                    },
                });

                updatedItems += 1;
            }
        }

        await prisma.practicePaper.update({
            where: { id },
            data: { status: "graded" },
        });

        logger.info({ paperId: id, resultsCount: results.length, updatedItems }, 'Paper graded');

        return NextResponse.json({ ok: true, updatedItems });
    } catch (error) {
        logger.error({ error }, 'Error grading paper');
        return internalError("Failed to grade paper");
    }
}
