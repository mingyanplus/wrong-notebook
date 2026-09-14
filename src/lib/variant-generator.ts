/**
 * 变式题后台生成器：按用户配置为错题补齐各难度变式题（VariantQuestion 题库）。
 * 进程内串行队列逐个执行（AI 生成是网络重活，防限流）；单题失败跳过，
 * 因按「缺额」补齐，补齐轮结束后重算缺额、仍有缺口自动再排一轮（≤MAX_BACKFILL_ROUNDS 轮），
 * 错题入库触发的任务下次入库/补齐时也会自然重试。
 * 执行时重新读取用户配置（排队期间配置可能被关闭/修改，以最新为准）。
 * 注意：队列在进程内存中，服务重启会丢失，需重新点「为现有错题补齐」。
 */

import { prisma } from "./prisma";
import { getAIService } from "@/lib/ai";
import { createLogger } from "@/lib/logger";
import { getErrorCategoryLabel } from "@/lib/error-categories";
import { parseLegacyKnowledgePoints } from "@/lib/knowledge-tags";
import { parseVariantSettings, totalVariantCount, DIFFICULTY_LEVELS } from "@/lib/variant-settings";
import type { VariantSettings } from "@/lib/variant-settings";

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
 * 一轮跑完后重算缺额，仍有缺口（说明有失败）自动续跑，见 runBackfillRound。
 * @returns 排队的错题数
 */
export async function scheduleBackfillVariants(userId: string): Promise<number> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { variantSettings: true },
    });
    const settings = parseVariantSettings(user?.variantSettings);
    if (!settings.enabled || totalVariantCount(settings) === 0) return 0;

    const deficit = await computeDeficitItemIds(userId, settings);
    if (deficit.length > 0) {
        enqueue(() => runBackfillRound(userId, deficit, 1));
    }
    logger.info({ userId, queued: deficit.length }, 'Variant backfill queued');
    return deficit.length;
}

/** 补齐轮次上限：失败的题自动续跑，但防 AI 服务持续异常（限流/断网/密钥失效）时空转 */
const MAX_BACKFILL_ROUNDS = 3;

/**
 * 算出各难度仍有缺额的错题 ID（首轮排队与失败重试共用）。
 * scopeIds 限定重算范围：重试轮只查本轮处理过的题（缺额只会来自失败），避免全表扫描；
 * 执行期间调大配置产生的新缺额不在此自动补，由用户再次点补齐覆盖。
 */
async function computeDeficitItemIds(userId: string, settings: VariantSettings, scopeIds?: string[]): Promise<string[]> {
    const existing = await prisma.variantQuestion.groupBy({
        by: ["errorItemId", "difficulty"],
        where: scopeIds ? { errorItemId: { in: scopeIds } } : { errorItem: { userId } },
        _count: { _all: true },
    });
    const countByItemDiff = new Map(existing.map((e) => [`${e.errorItemId}:${e.difficulty}`, e._count._all]));

    const items = await prisma.errorItem.findMany({
        where: scopeIds ? { id: { in: scopeIds } } : { userId, questionText: { not: null } },
        select: { id: true },
    });
    return items
        .filter((it) =>
            DIFFICULTY_LEVELS.some((d) => (countByItemDiff.get(`${it.id}:${d}`) ?? 0) < settings.perDifficulty[d])
        )
        .map((it) => it.id);
}

/**
 * 执行一轮补齐：串行处理完本轮题目后重算缺额，若仍有缺口（说明本轮有失败）
 * 自动再排一轮（≤MAX_BACKFILL_ROUNDS 轮）。重排前重读最新配置（可能已被关闭/调小）。
 */
async function runBackfillRound(userId: string, ids: string[], round: number): Promise<void> {
    for (const id of ids) {
        try {
            await generateForItem(id);
        } catch (e) {
            // generateForItem 内部已兜住 AI 失败；这里兜查询类异常，防单题崩溃中断整轮
            logger.warn({ errorItemId: id, error: e instanceof Error ? e.message : String(e) }, 'Variant backfill item crashed');
        }
    }

    if (round >= MAX_BACKFILL_ROUNDS) {
        logger.warn({ userId, round }, 'Variant backfill hit retry limit, gaps remain (retry by clicking backfill again)');
        return;
    }

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { variantSettings: true },
    });
    const settings = parseVariantSettings(user?.variantSettings);
    if (!settings.enabled || totalVariantCount(settings) === 0) return; // 配置已关闭/调空，停止续跑

    const remaining = await computeDeficitItemIds(userId, settings, ids);
    if (remaining.length > 0) {
        logger.info({ userId, remaining: remaining.length, round: round + 1 }, 'Variant backfill retry round queued');
        enqueue(() => runBackfillRound(userId, remaining, round + 1));
    }
}
