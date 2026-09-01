import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:error-items:sources');

/**
 * 获取当前用户所有来源试卷（去重），用于筛选下拉
 */
export async function GET() {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    try {
        const userId = session.user.id;
        const items = await prisma.errorItem.findMany({
            where: { userId, source: { not: null } },
            select: { source: true },
            distinct: ["source"],
        });

        const sources = items
            .map((i) => i.source)
            .filter((s): s is string => !!s)
            .sort((a, b) => a.localeCompare(b, "zh"));

        return NextResponse.json(sources);
    } catch (error) {
        logger.error({ error }, 'Error fetching sources');
        return internalError("Failed to fetch sources");
    }
}
