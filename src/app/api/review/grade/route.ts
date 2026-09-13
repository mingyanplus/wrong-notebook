import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, badRequest, notFound, forbidden } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getAIService } from "@/lib/ai";

const logger = createLogger('api:review:grade');

/**
 * 扫图批改（复习卷闭环三期）：上传孩子在纸质复习卷上一道题的作答图片，
 * 或手动输入作答文字（图片识别不佳时的兜底），AI 对照题干与参考答案批改，
 * 返回对/错判定 + 家长向点评。结果不落库——前端展示点评，家长确认后走
 * /api/review/complete 录入掌握度。
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    try {
        const body = (await req.json()) as { errorItemId?: unknown; imageBase64?: unknown; studentAnswer?: unknown };
        if (typeof body.errorItemId !== "string") {
            return badRequest("errorItemId is required");
        }
        const hasImage = typeof body.imageBase64 === "string" && body.imageBase64.length > 0;
        const hasStudentAnswer = typeof body.studentAnswer === "string" && body.studentAnswer.trim().length > 0;
        if (!hasImage && !hasStudentAnswer) {
            return badRequest("imageBase64 or studentAnswer is required");
        }

        const item = await prisma.errorItem.findUnique({
            where: { id: body.errorItemId },
            select: {
                userId: true,
                questionText: true,
                answerText: true,
                gradeSemester: true,
            },
        });
        if (!item) {
            return notFound("Item not found");
        }
        if (item.userId !== session.user.id) {
            return forbidden("Not authorized");
        }
        if (!item.questionText) {
            return badRequest("Item has no question text");
        }

        const ai = getAIService();
        const result = await ai.gradeAnswer(
            item.questionText,
            item.answerText ?? "（无参考答案，请依据题目本身判断）",
            {
                imageBase64: hasImage ? (body.imageBase64 as string) : undefined,
                studentAnswer: hasStudentAnswer ? (body.studentAnswer as string) : undefined,
            },
            "zh",
            item.gradeSemester
        );

        logger.info({ errorItemId: body.errorItemId, isCorrect: result.isCorrect, mode: hasImage ? "image" : "text" }, 'Answer graded');
        return NextResponse.json(result);
    } catch (error) {
        logger.error({ error }, 'Error grading answer');
        return internalError("Failed to grade answer");
    }
}
