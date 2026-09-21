import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { buildErrorCategoryWhere } from "@/lib/error-categories";
import { parseImageMasks } from "@/lib/image-masks";
import { parseLegacyKnowledgePoints } from "@/lib/knowledge-tags";
import { parseReviewSettings, MAX_DAILY_LIMIT, UNCATEGORIZED_SENTINEL, parseDueSortMode } from "@/lib/review-settings";
import type { DueSortMode } from "@/lib/review-settings";

const logger = createLogger('api:review:due');

/** 复习数量安全上限（用户设置 dailyLimit=null 即不限时兜底，防一次拉爆） */
const HARD_LIMIT = MAX_DAILY_LIMIT;

/** FNV-1a 32 位字符串 hash：乱序 key（按题目 id 计算，同一批题刷新/重开后顺序不变） */
function hashString(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/**
 * 获取当前用户到期待复习的错题列表（艾宾浩斯计划）
 * 应用用户复习设置：勾选的错因类型过滤 + 每日数量上限
 * 排序：默认掌握度低优先、到期早优先；sort=desc 反向；sort=random 按题目 id hash 确定性乱序；sort=tag 按 asc 返回（前端分组）
 * GET /api/review/due?subjectId=xxx&sort=asc|desc|random|tag
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
        // 原图是 base64 大字段：仅打印场景（include=image）拉取，横幅列表（只用题干/标签）不拉
        const includeImage = searchParams.get("include") === "image";
        // 排序模式：非法值由 parseDueSortMode 回退默认 asc；tag（前端按知识点分组）也按 asc 返回
        const sort: DueSortMode = parseDueSortMode(searchParams.get("sort"));
        // random/tag 均保持 asc：每日数量截断的口径不变（仍取最薄弱+最早到期的一批），
        // 乱序在 take 之后做，知识点分组由前端渲染时做
        const direction = sort === "desc" ? "desc" : "asc";

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { reviewSettings: true },
        });
        const settings = parseReviewSettings(user?.reviewSettings);

        const schedules = await prisma.reviewSchedule.findMany({
            where: {
                completedAt: null,
                scheduledFor: { lte: new Date() },
                errorItem: {
                    userId,
                    ...(subjectId ? { subjectId } : {}),
                    // 重点复习：勾选了错因类型时只看这些错因；勾选「未分类」时同时包含没录错因的题
                    ...buildErrorCategoryWhere(settings.errorCategories ?? [], UNCATEGORIZED_SENTINEL),
                },
            },
            orderBy: [
                { errorItem: { masteryLevel: direction } },
                { scheduledFor: direction },
            ],
            include: {
                errorItem: {
                    select: {
                        id: true,
                        questionText: true,
                        ...(includeImage
                            ? { originalImageUrl: true, imageMasks: true } // 复习卷打印用（去红 + 遮罩）
                            : {}),
                        knowledgePoints: true, // 老数据回退用（tags 为空时）
                        tags: { select: { name: true } },
                    },
                },
            },
            take: settings.dailyLimit ?? HARD_LIMIT,
        });

        const items = schedules.map((s) => ({
            scheduleId: s.id,
            overdueDays: Math.max(
                0,
                Math.floor((Date.now() - s.scheduledFor.getTime()) / 86400000)
            ),
            errorItem: {
                id: s.errorItem.id,
                questionText: s.errorItem.questionText,
                ...(includeImage
                    ? {
                          originalImageUrl: s.errorItem.originalImageUrl,
                          imageMasks: parseImageMasks(s.errorItem.imageMasks),
                      }
                    : {}),
                // 知识点标签优先，老数据回退 knowledgePoints JSON（与错题列表口径一致）
                knowledgeTags:
                    s.errorItem.tags.length > 0
                        ? s.errorItem.tags.map((t) => t.name)
                        : parseLegacyKnowledgePoints(s.errorItem.knowledgePoints),
            },
        }));

        // 确定性乱序：同一批题每次刷新顺序一致（hash 冲突时回退 id 比较，保证全序稳定）
        if (sort === "random") {
            items.sort((a, b) => hashString(a.errorItem.id) - hashString(b.errorItem.id) || a.errorItem.id.localeCompare(b.errorItem.id));
        }

        return NextResponse.json({ count: items.length, items });
    } catch (error) {
        logger.error({ error }, 'Error fetching due reviews');
        return internalError("Failed to fetch due reviews");
    }
}
