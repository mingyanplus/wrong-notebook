import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, notFound, forbidden } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { parseImageMasks } from "@/lib/image-masks";

const logger = createLogger('api:practice:paper:detail');

/** 试卷详情（含题目快照；原题实时 join 源错题取 requiresImage/imageMasks——遮罩是原图属性，后标注对已有试卷也生效） */
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

        // 原题 join 源错题：requiresImage 实时值优先（快照后用户可编辑/补全），遮罩只能来自源错题
        const sourceIds = paper.questions
            .filter((q) => !q.isVariant && q.sourceErrorItemId)
            .map((q) => q.sourceErrorItemId as string);
        const sources = sourceIds.length > 0
            ? await prisma.errorItem.findMany({
                where: { id: { in: sourceIds } },
                select: { id: true, requiresImage: true, imageMasks: true },
            })
            : [];
        const sourceById = new Map(sources.map((s) => [s.id, s]));

        const questions = paper.questions.map((q) => {
            if (q.isVariant || !q.sourceErrorItemId) {
                return { ...q, imageMasks: [] };
            }
            const source = sourceById.get(q.sourceErrorItemId);
            return {
                ...q,
                requiresImage: source?.requiresImage ?? q.requiresImage,
                imageMasks: parseImageMasks(source?.imageMasks),
            };
        });

        return NextResponse.json({ ...paper, questions });
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
