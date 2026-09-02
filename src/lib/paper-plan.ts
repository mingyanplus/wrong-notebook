/**
 * 组卷出题计划（纯函数）
 *
 * 语义：target = 试卷目标题数（而非选中错题数）。
 * 错题池不足时，按薄弱度顺序循环错题池用变式补齐，单题变式数不超过 perItemVariantCap。
 */

export interface PlanInputItem<T> {
    item: T;
    isVariant: boolean;
}

export type PaperMode = "original" | "variant" | "mixed";

/**
 * 生成出题计划。
 * @param pool  已按薄弱度降序排好的错题池
 * @param mode  组卷模式
 * @param target 试卷目标题数
 * @param variantRatio mixed 模式变式占比（0-1）
 * @param perItemVariantCap 单题变式上限（防止同题铺满整卷）
 */
export function buildPaperPlan<T>(
    pool: T[],
    mode: PaperMode,
    target: number,
    variantRatio = 0.5,
    perItemVariantCap = 3,
    getId: (item: T) => string
): PlanInputItem<T>[] {
    if (pool.length === 0 || target <= 0) return [];

    const plan: PlanInputItem<T>[] = [];

    if (mode === "original") {
        // 纯原题：池不足时只能少于 target
        for (const item of pool) {
            if (plan.length >= target) break;
            plan.push({ item, isVariant: false });
        }
        return plan;
    }

    if (mode === "variant") {
        // 纯变式：轮询池补齐，单题不超过 cap
        let round = 0;
        while (plan.length < target && round < perItemVariantCap) {
            for (const item of pool) {
                if (plan.length >= target) break;
                plan.push({ item, isVariant: true });
            }
            round += 1;
        }
        return plan;
    }

    // mixed：先按比例放原题，再轮询池用变式补齐到 target
    const originalCount = Math.min(pool.length, Math.round(target * (1 - variantRatio)));
    for (const item of pool.slice(0, originalCount)) {
        plan.push({ item, isVariant: false });
    }

    const variantCountByItem = new Map<string, number>();
    let idx = 0;
    // 安全阀：最多尝试 池×cap 轮，避免死循环
    const maxAttempts = pool.length * perItemVariantCap;
    for (let attempts = 0; plan.length < target && attempts < maxAttempts; attempts++) {
        const item = pool[idx % pool.length];
        idx += 1;
        const used = variantCountByItem.get(getId(item)) ?? 0;
        if (used >= perItemVariantCap) continue;
        variantCountByItem.set(getId(item), used + 1);
        plan.push({ item, isVariant: true });
    }
    return plan;
}
