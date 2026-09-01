import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, notFound, forbidden } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:practice:paper:detail');

/** 试卷详情（含题目快照） */
export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    try {
        const paper = await prisma.practicePaper.findUnique({
            where: { id },
            include: { questions: { orderBy: { order: "asc" } } },
        });

        if (!paper) {
            return notFound("Paper not found");
        }
        if (paper.userId !== session.user.id) {
            return forbidden("Not authorized");
        }

        return NextResponse.json(paper);
    } catch (error) {
        logger.error({ error }, 'Error fetching paper');
        return internalError("Failed to fetch paper");
    }
}

/** 删除试卷 */
export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    try {
        const paper = await prisma.practicePaper.findUnique({ where: { id }, select: { userId: true } });
        if (!paper) {
            return notFound("Paper not found");
        }
        if (paper.userId !== session.user.id) {
            return forbidden("Not authorized");
        }

        await prisma.practicePaper.delete({ where: { id } });
        return NextResponse.json({ ok: true });
    } catch (error) {
        logger.error({ error }, 'Error deleting paper');
        return internalError("Failed to delete paper");
    }
}
