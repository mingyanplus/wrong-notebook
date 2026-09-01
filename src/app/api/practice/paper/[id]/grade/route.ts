import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, notFound, forbidden, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { advanceReviewSchedule } from "@/lib/scheduler";

const logger = createLogger('api:practice:paper:grade');

/**
 * 录成绩（纸质卷闭环断点）：逐题对/错 → 回写试卷题目结果 +
 * 掌握度升降 + PracticeRecord + 艾宾浩斯复习计划推进（事务内执行）
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

        if (!paper) {
            return notFound("Paper not found");
        }
        if (paper.userId !== userId) {
            return forbidden("Not authorized");
        }

        const questionMap = new Map(paper.questions.map((q) => [q.id, q]));
        const validResults = results
            .map((r: { questionId: string; isCorrect: boolean }) => {
                const q = questionMap.get(r.questionId);
                return q ? { q, isCorrect: !!r.isCorrect } : null;
            })
            .filter((x): x is { q: NonNullable<ReturnType<typeof questionMap.get>>; isCorrect: boolean } => x !== null);

        // 按对/错分组的批量题目结果回写
        const correctQIds = validResults.filter((r) => r.isCorrect).map((r) => r.q.id);
        const wrongQIds = validResults.filter((r) => !r.isCorrect).map((r) => r.q.id);

        // 关联的原错题（去重，一卷内同一错题可能对应多道变式题——以最后一题结果为准）
        const lastResultByItem = new Map<string, boolean>();
        for (const r of validResults) {
            if (r.q.sourceErrorItemId) lastResultByItem.set(r.q.sourceErrorItemId, r.isCorrect);
        }
        const sourceIds = Array.from(lastResultByItem.keys());

        const subject = paper.subjectId
            ? await prisma.subject.findUnique({ where: { id: paper.subjectId }, select: { name: true } })
            : null;

        await prisma.$transaction(async (tx) => {
            if (correctQIds.length) {
                await tx.paperQuestion.updateMany({ where: { id: { in: correctQIds } }, data: { isCorrect: true } });
            }
            if (wrongQIds.length) {
                await tx.paperQuestion.updateMany({ where: { id: { in: wrongQIds } }, data: { isCorrect: false } });
            }

            for (const [itemId, isCorrect] of lastResultByItem) {
                await advanceReviewSchedule(itemId, isCorrect, tx);
            }

            if (sourceIds.length) {
                await tx.practiceRecord.createMany({
                    data: sourceIds.map((itemId) => ({
                        userId,
                        subject: subject?.name || null,
                        isCorrect: lastResultByItem.get(itemId) ?? false,
                    })),
                });
            }

            await tx.practicePaper.update({ where: { id }, data: { status: "graded" } });
        });

        logger.info({ paperId: id, resultsCount: validResults.length, updatedItems: sourceIds.length }, 'Paper graded');

        return NextResponse.json({ ok: true, updatedItems: sourceIds.length });
    } catch (error) {
        logger.error({ error }, 'Error grading paper');
        return internalError("Failed to grade paper");
    }
}
