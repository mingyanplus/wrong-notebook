/**
 * 变式题后台生成器：按用户配置为错题补齐各难度变式题（VariantQuestion 题库）。
 * 一次 AI 请求按缺额清单批量生成多道变式（解构原题的思考成本只付一次），
 * 同一错题内不再逐题逐难度串行请求。
 * 速率保护（防 429）：全局请求间隔（VARIANT_REQUEST_INTERVAL 秒，默认 10）+ 限流自动退避重试。
 * 进程内并发队列执行（并发 2：AI 生成是网络重活，防限流）；单题失败跳过，
 * 因按「缺额」补齐，补齐轮结束后重算缺额、仍有缺口自动再排一轮（≤MAX_BACKFILL_ROUNDS 轮），
 * 错题入库触发的任务下次入库/补齐时也会自然重试。
 * 配置读取：单题任务用入队/轮首时的快照（新鲜度窗口≈一轮，省每题重复读 user），
 * 每轮续跑前重读最新配置决定是否继续。
 * 注意：队列与进度在进程内存中，服务重启会丢失，需重新点「为现有错题补齐」。
 */

import { prisma } from "./prisma";
import { getAIService } from "@/lib/ai";
import { createLogger } from "@/lib/logger";
import { getErrorCategoryLabel } from "@/lib/error-categories";
import { parseLegacyKnowledgePoints } from "@/lib/knowledge-tags";
import { parseVariantSettings, totalVariantCount, DIFFICULTY_LEVELS } from "@/lib/variant-settings";
import type { VariantSettings, VariantProgress } from "@/lib/variant-settings";

// 类型经 variant-settings 导出（前端 type import 不应拉起本模块的 prisma 依赖）
export type { VariantProgress } from "@/lib/variant-settings";

const logger = createLogger('variant-generator');

// 并发上限：默认 2 路并行（AI 生成是网络重活，防限流）；可用环境变量 VARIANT_MAX_CONCURRENCY 覆盖（1-8）
const MAX_CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.VARIANT_MAX_CONCURRENCY) || 2));

// ── 速率保护：全局请求间隔 + 429 退避重试 ──────────────────────
// 相邻 AI 请求的最小间隔（毫秒），从源头控制 RPM，防止批量补齐时打满 AI 服务速率限制；
// 环境变量 VARIANT_REQUEST_INTERVAL 可调（秒，0 = 关闭）
const REQUEST_INTERVAL_MS = Math.max(0, (Number(process.env.VARIANT_REQUEST_INTERVAL) || 10) * 1000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 链式节流：保证并发 worker 串行判定间隔（即使间隔为 0 也维持调用点统一）
let lastRequestAt = 0;
let throttleChain: Promise<void> = Promise.resolve();
function throttle(): Promise<void> {
    const run = throttleChain.then(async () => {
        const wait = lastRequestAt + REQUEST_INTERVAL_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastRequestAt = Date.now();
    });
    throttleChain = run.catch(() => {});
    return run;
}

/** 限流类错误判定（provider 抛出的 AI_QUOTA_EXCEEDED / 429 / 速率限制类消息） */
function isRateLimitError(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.includes('AI_QUOTA_EXCEEDED') || msg.includes('429') || msg.includes('速率限制') || msg.includes('rate limit');
}

/**
 * 变式生成 AI 调用：先过全局节流；遇限流（429）自动退避重试（60s/120s/180s 递增，最多 3 次），
 * 仍失败或其他错误照常抛出（由补齐轮次兜底）。
 */
async function callAiWithRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    const MAX_RATE_LIMIT_RETRIES = 3;
    for (let attempt = 0; ; attempt++) {
        await throttle();
        try {
            return await fn();
        } catch (e) {
            if (!isRateLimitError(e) || attempt >= MAX_RATE_LIMIT_RETRIES) throw e;
            const backoffMs = 60_000 * (attempt + 1);
            logger.warn({ attempt: attempt + 1, backoffMs }, 'Variant generation rate-limited, backing off');
            await sleep(backoffMs);
        }
    }
}

// 进程内并发队列：N 个 worker 消费同一等待队列。
// 注意：只让「单题生成」级别的叶子任务入队，轮次调度（runBackfillRound）直接异步执行，
// 否则父任务占住并发槽等子任务，并发 2 实际退化成 1。
const waiting: Array<() => Promise<void>> = [];
let active = 0;

/**
 * 入队任务并返回执行结果 Promise：任务失败时 reject（已记日志）。
 * 调用方必须消费 reject（至少 .catch(() => {})），否则 unhandled rejection。
 */
function enqueue(task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        waiting.push(() =>
            task().then(resolve, (e) => {
                logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Variant task failed');
                reject(e);
            })
        );
        pump();
    });
}
function pump(): void {
    while (active < MAX_CONCURRENCY && waiting.length > 0) {
        const next = waiting.shift()!;
        active++;
        // 包装链自身不 reject（错误已转给出队的 enqueue Promise），finally 释放并发槽
        next().catch(() => {}).finally(() => {
            active--;
            pump();
        });
    }
}

const progressByUser = new Map<string, VariantProgress>();

export function getVariantProgress(userId: string): VariantProgress {
    return progressByUser.get(userId) ?? { active: false, total: 0, done: 0 };
}

/** 进度收尾（供调用方 catch 兜底：轮次链路异常时保证 active 复位，防 UI 永久转圈/防重入卡死） */
function stopProgress(userId: string): void {
    const p = progressByUser.get(userId);
    if (p) p.active = false;
}

/**
 * 为一道错题补齐缺失的变式题：按 settings 快照与已有数量算缺额，一次批量生成。
 * settings 由调用方传入（入库路径=入队前快照；补齐路径=轮首快照，轮末重读后续跑）。
 */
async function generateForItem(errorItemId: string, settings: VariantSettings): Promise<void> {
    if (!settings.enabled || totalVariantCount(settings) === 0) return;

    // 两个查询相互独立（groupBy 只按 errorItemId），并行取
    const [item, existing] = await Promise.all([
        prisma.errorItem.findUnique({
            where: { id: errorItemId },
            select: {
                questionText: true,
                knowledgePoints: true,
                gradeSemester: true,
                errorCategory: true,
            },
        }),
        prisma.variantQuestion.groupBy({
            by: ["difficulty"],
            where: { errorItemId },
            _count: { _all: true },
        }),
    ]);
    if (!item || !item.questionText) return; // 无题干无法生成
    // 提为局部 const：闭包（下方退避重试包装）内不保留属性级非空收窄
    const questionText = item.questionText;

    const tags = parseLegacyKnowledgePoints(item.knowledgePoints);
    const existingCount = new Map(existing.map((e) => [e.difficulty, e._count._all]));

    // 各难度缺额汇总成一次批量请求（0 缺额的档位自动被过滤）
    const requests = DIFFICULTY_LEVELS
        .map((difficulty) => ({
            difficulty,
            count: (settings.perDifficulty[difficulty] ?? 0) - (existingCount.get(difficulty) ?? 0),
        }))
        .filter((r) => r.count > 0);
    if (requests.length === 0) return;

    // 错因定向提示（变式生成瞄准薄弱点）
    const mistakeHint = item.errorCategory
        ? `该题错因：${getErrorCategoryLabel(item.errorCategory)}，变式请针对该薄弱点设计`
        : undefined;

    const ai = getAIService();
    // 限流退避 + 全局节流在此封装内（见 callAiWithRateLimitRetry）
    const result = await callAiWithRateLimitRetry(() =>
        ai.generateSimilarQuestions(
            questionText,
            tags,
            requests,
            undefined,
            item.gradeSemester,
            mistakeHint
        )
    );
    if (result.length > 0) {
        await prisma.variantQuestion.createMany({
            data: result.map((v) => ({
                errorItemId,
                difficulty: v.difficulty,
                questionText: v.questionText ?? "",
                answerText: v.answerText ?? "",
                analysis: v.analysis ?? "",
            })),
        });
    }
    // 批量返回数少于请求数（AI 少生成/块被丢弃）时留待下轮补齐兜底
}

/** 错题入库触发：读用户配置快速短路，启用则异步排队生成（fire-and-forget，不阻塞保存） */
export function scheduleVariantGeneration(errorItemId: string, userId: string): void {
    prisma.user
        .findUnique({ where: { id: userId }, select: { variantSettings: true } })
        .then((user) => {
            const settings = parseVariantSettings(user?.variantSettings);
            if (!settings.enabled || totalVariantCount(settings) === 0) return; // 快速短路
            enqueue(() => generateForItem(errorItemId, settings)).catch(() => {}); // 失败已记日志，下次入库/补齐自然重试
        })
        .catch((e) => logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Schedule variant failed'));
}

/**
 * 存量补齐：先一条聚合查询算出各题各难度已有数量，只把**有缺额**的错题排队
 * （已补齐的题不空跑）。已够数的题内部会跳过。
 * 一轮跑完后重算缺额，仍有缺口（说明有失败/少生成）自动续跑，见 runBackfillRound。
 * @returns 排队的错题数（上一轮仍在跑时返回其剩余量）
 */
export async function scheduleBackfillVariants(userId: string): Promise<number> {
    // 防重入：上一轮仍在跑时不再排队（避免进度对象被覆盖、任务重复）；先判后算，省掉全量聚合
    const current = progressByUser.get(userId);
    if (current?.active) {
        return current.total - current.done;
    }

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { variantSettings: true },
    });
    const settings = parseVariantSettings(user?.variantSettings);
    if (!settings.enabled || totalVariantCount(settings) === 0) return 0;

    const deficit = await computeDeficitItemIds(userId, settings);
    if (deficit.length > 0) {
        progressByUser.set(userId, { active: true, total: deficit.length, done: 0 });
        // 直接异步执行轮次调度（不入队占槽），子任务逐题入队并发消费
        runBackfillRound(userId, deficit, 1, settings).catch((e) => {
            stopProgress(userId);
            logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Variant backfill crashed');
        });
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
 * 执行一轮补齐：逐题入队（并发消费），全部完成后重算缺额，若仍有缺口（说明本轮有失败/少生成）
 * 自动再排一轮（≤MAX_BACKFILL_ROUNDS 轮）。重排前重读最新配置（可能已被关闭/调小）。
 * 进度收尾（active=false）收敛在本函数各出口的 stop() 与调用方 catch 的 stopProgress；
 * 新增出口时记得调 stop()，漏掉会让该用户进度永久卡在 active。
 */
async function runBackfillRound(userId: string, ids: string[], round: number, settings: VariantSettings): Promise<void> {
    const progress = progressByUser.get(userId);
    const stop = () => { if (progress) progress.active = false; };

    await Promise.all(
        ids.map((id) =>
            enqueue(() => generateForItem(id, settings))
                .catch(() => {}) // 单题失败已记日志，缺口由本轮末重算续跑兜底
                .finally(() => {
                    if (progress) progress.done++;
                })
        )
    );

    if (round >= MAX_BACKFILL_ROUNDS) {
        logger.warn({ userId, round }, 'Variant backfill hit retry limit, gaps remain (retry by clicking backfill again)');
        stop();
        return;
    }

    // 轮末重读最新配置（轮次进行中可能被关闭/调小）
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { variantSettings: true },
    });
    const latest = parseVariantSettings(user?.variantSettings);
    if (!latest.enabled || totalVariantCount(latest) === 0) {
        stop();
        return;
    }

    const remaining = await computeDeficitItemIds(userId, latest, ids);
    if (remaining.length > 0) {
        if (progress) progress.total = progress.done + remaining.length;
        logger.info({ userId, remaining: remaining.length, round: round + 1 }, 'Variant backfill retry round queued');
        runBackfillRound(userId, remaining, round + 1, latest).catch((e) => {
            stopProgress(userId);
            logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Variant backfill retry crashed');
        });
    } else {
        stop();
    }
}
