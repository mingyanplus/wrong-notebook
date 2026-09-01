import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, notFound } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { advanceReviewSchedule } from "@/lib/scheduler";

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

            await advanceReviewSchedule(errorItemId, !!isCorrect);
            logger.info({ errorItemId, isCorrect }, 'Review schedule advanced');
        }

        return NextResponse.json(record);
    } catch (error) {
        logger.error({ error }, 'Error saving practice record');
        return internalError("Failed to save record");
    }
}
