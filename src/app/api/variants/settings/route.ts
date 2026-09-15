import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { parseVariantSettings, serializeVariantSettings, totalVariantCount } from "@/lib/variant-settings";
import { getVariantProgress } from "@/lib/variant-generator";

const logger = createLogger('api:variants:settings');

async function loadStats(userId: string) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { variantSettings: true },
    });
    const settings = parseVariantSettings(user?.variantSettings);
    const [itemCount, variantCount] = await Promise.all([
        prisma.errorItem.count({ where: { userId, questionText: { not: null } } }),
        prisma.variantQuestion.count({ where: { errorItem: { userId } } }),
    ]);
    return {
        settings,
        stats: {
            itemCount,
            variantCount,
            targetCount: itemCount * totalVariantCount(settings),
            enabled: settings.enabled,
        },
    };
}

/** 获取当前用户变式自动生成配置、题库进度统计与补齐进度（一次请求拿全）；?statsOnly=1 时只返回统计供轮询使用 */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
        return unauthorized();
    }
    try {
        const { settings, stats } = await loadStats(session.user.id);
        const progress = getVariantProgress(session.user.id);
        const statsOnly = new URL(req.url).searchParams.get("statsOnly") === "1";
        return NextResponse.json(statsOnly ? { stats, progress } : { settings, stats, progress });
    } catch (error) {
        logger.error({ error }, 'Error fetching variant settings');
        return internalError("Failed to fetch variant settings");
    }
}

/** 保存变式自动生成配置（parseVariantSettings 规整非法值） */
export async function PUT(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
        return unauthorized();
    }
    try {
        const body: unknown = await req.json();
        if (typeof body !== "object" || body === null) {
            return badRequest("Invalid body");
        }
        const settings = parseVariantSettings(body);
        await prisma.user.update({
            where: { id: session.user.id },
            data: { variantSettings: serializeVariantSettings(settings) },
        });
        return NextResponse.json(settings);
    } catch (error) {
        logger.error({ error }, 'Error saving variant settings');
        return internalError("Failed to save variant settings");
    }
}
