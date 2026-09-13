/**
 * 变式题后台生成器：按用户配置为错题补齐各难度变式题（VariantQuestion 题库）。
 * 进程内串行队列逐个执行（AI 生成是网络重活，防限流）；单题失败跳过，
 * 因按「缺额」补齐，下次入库触发/存量补齐时自然重试。
 * 执行时重新读取用户配置（排队期间配置可能被关闭/修改，以最新为准）。
 */

import { prisma } from "./prisma";
import { getAIService } from "@/lib/ai";
import { createLogger } from "@/lib/logger";
import { getErrorCategoryLabel } from "@/lib/error-categories";
import { parseLegacyKnowledgePoints } from "@/lib/knowledge-tags";
import { parseVariantSettings, totalVariantCount, DIFFICULTY_LEVELS } from "@/lib/variant-settings";

const logger = createLogger('variant-generator');

// 进程内串行队列
let queue: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
    queue = queue
        .then(task)
        .catch((e) => logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Variant task failed'));
}

/** 为一道错题补齐缺失的变式题（按执行时的最新配置与已有数量算缺额） */
async function generateForItem(errorItemId: string): Promise<void> {
    const item = await prisma.errorItem.findUnique({
        where: { id: errorItemId },
        select: {
            userId: true,
            questionText: true,
            knowledgePoints: true,
            gradeSemester: true,
            errorCategory: true,
        },
    });
    if (!item || !item.questionText) return; // 无题干无法生成

    // 配置以执行时为准（排队期间可能被关闭/调整）
    const user = await prisma.user.findUnique({
        where: { id: item.userId },
        select: { variantSettings: true },
    });
    const current = parseVariantSettings(user?.variantSettings);
    if (!current.enabled || totalVariantCount(current) === 0) return;

    const tags = parseLegacyKnowledgePoints(item.knowledgePoints);

    const existing = await prisma.variantQuestion.groupBy({
        by: ["difficulty"],
        where: { errorItemId },
        _count: { _all: true },
    });
    const existingCount = new Map(existing.map((e) => [e.difficulty, e._count._all]));

    // 错因定向提示（变式生成瞄准薄弱点）
    const mistakeHint = item.errorCategory
        ? `该题错因：${getErrorCategoryLabel(item.errorCategory)}，变式请针对该薄弱点设计`
        : undefined;

    const ai = getAIService();
    for (const difficulty of DIFFICULTY_LEVELS) {
        const target = current.perDifficulty[difficulty] ?? 0;
        const need = target - (existingCount.get(difficulty) ?? 0);
        for (let i = 0; i < need; i++) {
            try {
                const result = await ai.generateSimilarQuestion(
                    item.questionText,
                    tags,
                    undefined,
                    difficulty,
                    item.gradeSemester,
                    mistakeHint
                );
                await prisma.variantQuestion.create({
                    data: {
                        errorItemId,
                        difficulty,
                        questionText: result.questionText ?? "",
                        answerText: result.answerText ?? "",
                        analysis: result.analysis ?? "",
                    },
                });
            } catch (e) {
                logger.warn(
                    { errorItemId, difficulty, error: e instanceof Error ? e.message : String(e) },
                    'Variant generation failed (skipped, retried on next backfill)'
                );
                break; // 该难度失败即停（连续失败大概率是限流/服务问题），留待下次补齐
            }
        }
    }
}

/** 错题入库触发：读用户配置快速短路，启用则异步排队生成（fire-and-forget，不阻塞保存） */
export function scheduleVariantGeneration(errorItemId: string, userId: string): void {
    prisma.user
        .findUnique({ where: { id: userId }, select: { variantSettings: true } })
        .then((user) => {
            const settings = parseVariantSettings(user?.variantSettings);
            if (!settings.enabled || totalVariantCount(settings) === 0) return; // 快速短路；权威判断在执行时重读
            enqueue(() => generateForItem(errorItemId));
        })
        .catch((e) => logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Schedule variant failed'));
}

/**
 * 存量补齐：先一条聚合查询算出各题各难度已有数量，只把**有缺额**的错题排队
 * （已补齐的题不空跑三连查询）。已够数的题内部会跳过。
 * @returns 排队的错题数
 */
export async function scheduleBackfillVariants(userId: string): Promise<number> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { variantSettings: true },
    });
    const settings = parseVariantSettings(user?.variantSettings);
    if (!settings.enabled || totalVariantCount(settings) === 0) return 0;

    const existing = await prisma.variantQuestion.groupBy({
        by: ["errorItemId", "difficulty"],
        where: { errorItem: { userId } },
        _count: { _all: true },
    });
    const countByItemDiff = new Map(existing.map((e) => [`${e.errorItemId}:${e.difficulty}`, e._count._all]));

    const items = await prisma.errorItem.findMany({
        where: { userId, questionText: { not: null } },
        select: { id: true },
    });
    const deficit = items.filter((it) =>
        DIFFICULTY_LEVELS.some((d) => (countByItemDiff.get(`${it.id}:${d}`) ?? 0) < settings.perDifficulty[d])
    );
    for (const it of deficit) {
        enqueue(() => generateForItem(it.id));
    }
    logger.info({ userId, queued: deficit.length }, 'Variant backfill queued');
    return deficit.length;
}
