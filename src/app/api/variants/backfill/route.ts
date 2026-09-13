import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { scheduleBackfillVariants } from "@/lib/variant-generator";

const logger = createLogger('api:variants:backfill');

/**
 * 存量错题变式补齐：把该用户全部有题干的错题排入后台生成队列（已够数的题内部跳过）。
 * 异步执行，立即返回排队数。POST /api/variants/backfill
 */
export async function POST() {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
        return unauthorized();
    }
    try {
        const queued = await scheduleBackfillVariants(session.user.id);
        if (queued === 0) {
            return badRequest("Variant auto-generation is disabled or no items to process");
        }
        logger.info({ userId: session.user.id, queued }, 'Variant backfill triggered');
        return NextResponse.json({ ok: true, queued });
    } catch (error) {
        logger.error({ error }, 'Error triggering variant backfill');
        return internalError("Failed to trigger variant backfill");
    }
}
