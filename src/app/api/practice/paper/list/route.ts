import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:practice:paper:list');

/** 试卷列表 */
export async function GET() {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    try {
        const papers = await prisma.practicePaper.findMany({
            where: { userId: session.user.id },
            orderBy: { createdAt: "desc" },
            include: { questions: { select: { id: true, isCorrect: true } } },
        });

        return NextResponse.json(
            papers.map((p) => ({
                id: p.id,
                title: p.title,
                mode: p.mode,
                status: p.status,
                totalScore: p.totalScore,
                createdAt: p.createdAt,
                questionCount: p.questions.length,
                gradedCount: p.questions.filter((q) => q.isCorrect !== null && q.isCorrect !== undefined).length,
            }))
        );
    } catch (error) {
        logger.error({ error }, 'Error listing papers');
        return internalError("Failed to list papers");
    }
}
