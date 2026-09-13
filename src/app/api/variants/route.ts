import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:variants');

/**
 * 按错题 id 批量取变式题（打印复习卷勾选「举一反三」用）。
 * 只返回调用者本人错题的变式。GET /api/variants?errorItemIds=a,b,c
 */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    try {
        const { searchParams } = new URL(req.url);
        const ids = (searchParams.get("errorItemIds") ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 100); // 防御：一次最多 100 道题的变式

        if (ids.length === 0) {
            return NextResponse.json({ items: [] });
        }

        const items = await prisma.variantQuestion.findMany({
            where: {
                errorItemId: { in: ids },
                errorItem: { userId: session.user.id },
            },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                errorItemId: true,
                difficulty: true,
                questionText: true,
                answerText: true,
                analysis: true,
            },
        });

        return NextResponse.json({ items });
    } catch (error) {
        logger.error({ error }, 'Error fetching variants');
        return internalError("Failed to fetch variants");
    }
}
