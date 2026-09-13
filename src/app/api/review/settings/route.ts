import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { parseReviewSettings, serializeReviewSettings } from "@/lib/review-settings";

const logger = createLogger('api:review:settings');

/** 获取当前用户复习设置（每日数量上限 + 重点错因勾选） */
export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
        return unauthorized();
    }
    try {
        const user = await prisma.user.findUnique({
            where: { id: session.user.id },
            select: { reviewSettings: true },
        });
        return NextResponse.json(parseReviewSettings(user?.reviewSettings));
    } catch (error) {
        logger.error({ error }, 'Error fetching review settings');
        return internalError("Failed to fetch review settings");
    }
}

/** 保存复习设置（parseReviewSettings 规整：无效值丢弃、空勾选归一为不过滤） */
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
        // parseReviewSettings 接受对象直接规整：无效值丢弃、空勾选归一为不过滤
        const settings = parseReviewSettings(body);
        await prisma.user.update({
            where: { id: session.user.id },
            data: { reviewSettings: serializeReviewSettings(settings) },
        });
        return NextResponse.json(settings);
    } catch (error) {
        logger.error({ error }, 'Error saving review settings');
        return internalError("Failed to save review settings");
    }
}
