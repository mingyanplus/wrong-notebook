import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:review:due');

/**
 * 获取当前用户到期待复习的错题列表（艾宾浩斯计划）
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

        const schedules = await prisma.reviewSchedule.findMany({
            where: {
                completedAt: null,
                scheduledFor: { lte: new Date() },
                errorItem: {
                    userId,
                    ...(subjectId ? { subjectId } : {}),
                },
            },
            orderBy: { scheduledFor: 'asc' },
            include: {
                errorItem: {
                    select: {
                        id: true,
                        questionText: true,
                        subjectId: true,
                        masteryLevel: true,
                        originalImageUrl: true,
                    },
                },
            },
            take: 50,
        });

        const items = schedules.map((s) => ({
            scheduleId: s.id,
            scheduledFor: s.scheduledFor,
            overdueDays: Math.max(
                0,
                Math.floor((Date.now() - s.scheduledFor.getTime()) / 86400000)
            ),
            errorItem: s.errorItem,
        }));

        return NextResponse.json({ count: items.length, items });
    } catch (error) {
        logger.error({ error }, 'Error fetching due reviews');
        return internalError("Failed to fetch due reviews");
    }
}
