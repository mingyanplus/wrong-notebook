/**
 * 知识点薄弱度模型（纯函数，供 /api/stats/weakness 使用）
 *
 * score(tag) = Σ_item itemScore(item) × correctnessBoost(tag)
 *   itemScore = categoryWeight(item) × masteryFactor × recencyFactor
 *
 * 热力图 cell(tag, category) = Σ_item 该错因的贡献量（主 1.0 / 次 0.5）
 */
import { WEAKNESS_CONFIG } from "./weakness-config";
import { getErrorCategory, ERROR_CATEGORIES } from "./error-categories";

export interface WeaknessItemInput {
    id: string;
    errorCategory: string | null;
    secondaryErrorCategories: string | null; // JSON string
    masteryLevel: number;
    updatedAt: Date;
    tags: Array<{ id: string; name: string }>;
}

export interface WeaknessReviewInput {
    errorItemId: string;
    isCorrect: boolean;
}

export interface TagWeakness {
    tagId: string;
    tagName: string;
    score: number;
    itemCount: number;
    reviewCount: number;
    correctRate: number | null; // null = 无复习记录
    topCategory: string | null; // 该知识点下加权量最大的错因
}

export interface WeaknessReport {
    ranking: TagWeakness[];
    heatmap: {
        tags: string[];
        categories: Array<{ code: string; label: string }>;
        cells: number[][]; // [tagIndex][categoryIndex]
    };
}

/** 单题错因权重：主错因 weight + Σ 次错因 weight × 0.5 */
export function categoryWeight(errorCategory: string | null, secondaryJson: string | null): number {
    const primary = errorCategory
        ? getErrorCategory(errorCategory)?.weight ?? WEAKNESS_CONFIG.uncategorizedWeight
        : WEAKNESS_CONFIG.uncategorizedWeight;

    let secondary: string[] = [];
    try {
        const parsed = secondaryJson ? JSON.parse(secondaryJson) : [];
        if (Array.isArray(parsed)) secondary = parsed;
    } catch { /* 忽略非法 JSON */ }

    const secondaryTotal = secondary.reduce((sum, code) => {
        const w = getErrorCategory(code)?.weight ?? 0;
        return sum + w * WEAKNESS_CONFIG.secondaryWeightRatio;
    }, 0);

    return primary + secondaryTotal;
}

/** 时间衰减：floor + (1-floor) × 0.5^(days/halfLife) */
export function recencyFactor(updatedAt: Date, now: Date = new Date()): number {
    const days = Math.max(0, (now.getTime() - updatedAt.getTime()) / 86400000);
    const factor = Math.pow(0.5, days / WEAKNESS_CONFIG.recencyHalfLifeDays);
    return WEAKNESS_CONFIG.recencyFloor + (1 - WEAKNESS_CONFIG.recencyFloor) * factor;
}

/** 复习正确率调节：全错 ×1.2，全对 ×0.6，无记录 ×1.0 */
export function correctnessBoost(correctRate: number | null): number {
    if (correctRate === null) return 1.0;
    const { correctnessBoostMax: max, correctnessBoostMin: min } = WEAKNESS_CONFIG;
    return min + (max - min) * (1 - correctRate);
}

/** 汇总生成薄弱度排行 + 错因热力图 */
export function computeWeaknessReport(
    items: WeaknessItemInput[],
    reviews: WeaknessReviewInput[],
    now: Date = new Date()
): WeaknessReport {
    // 按 tag 聚合
    const byTag = new Map<string, { name: string; items: WeaknessItemInput[] }>();
    for (const item of items) {
        for (const tag of item.tags) {
            const entry = byTag.get(tag.id) ?? { name: tag.name, items: [] };
            entry.items.push(item);
            byTag.set(tag.id, entry);
        }
    }

    // itemId → 复习正确率
    const reviewsByItem = new Map<string, { correct: number; total: number }>();
    for (const r of reviews) {
        const entry = reviewsByItem.get(r.errorItemId) ?? { correct: 0, total: 0 };
        entry.total += 1;
        if (r.isCorrect) entry.correct += 1;
        reviewsByItem.set(r.errorItemId, entry);
    }

    const categories = ERROR_CATEGORIES.map((c) => ({ code: c.code, label: c.label }));
    const categoryIndex = new Map(categories.map((c, i) => [c.code, i]));

    // 逐 tag 计算
    const ranking: TagWeakness[] = [];
    const heatmaps = new Map<string, number[]>(); // tagId → 各错因加权量

    for (const [tagId, { name, items: tagItems }] of byTag) {
        const cells = new Array(categories.length).fill(0);
        let score = 0;
        let reviewCount = 0;
        let correct = 0;

        for (const item of tagItems) {
            const mastery = WEAKNESS_CONFIG.masteryFactor[item.masteryLevel] ?? 1.0;
            const itemScore = categoryWeight(item.errorCategory, item.secondaryErrorCategories) * mastery * recencyFactor(item.updatedAt, now);

            // 热力图贡献（不加掌握度/时间因子，展示原始错因分布）
            const primaryIdx = item.errorCategory ? categoryIndex.get(item.errorCategory) : undefined;
            if (primaryIdx !== undefined) cells[primaryIdx] += 1.0;
            let secondary: string[] = [];
            try {
                const parsed = item.secondaryErrorCategories ? JSON.parse(item.secondaryErrorCategories) : [];
                if (Array.isArray(parsed)) secondary = parsed;
            } catch { /* ignore */ }
            for (const code of secondary) {
                const idx = categoryIndex.get(code);
                if (idx !== undefined) cells[idx] += WEAKNESS_CONFIG.secondaryWeightRatio;
            }

            const r = reviewsByItem.get(item.id);
            if (r) {
                reviewCount += r.total;
                correct += r.correct;
            }

            score += itemScore;
        }

        const correctRate = reviewCount > 0 ? correct / reviewCount : null;
        ranking.push({
            tagId,
            tagName: name,
            score: Math.round(score * correctnessBoost(correctRate) * 100) / 100,
            itemCount: tagItems.length,
            reviewCount,
            correctRate,
            topCategory: primaryTopCategory(cells, categories),
        });
        heatmaps.set(tagId, cells);
    }

    ranking.sort((a, b) => b.score - a.score);

    // 热力图只取 Top N tag
    const topTags = ranking.slice(0, WEAKNESS_CONFIG.heatmapTopTags);
    return {
        ranking,
        heatmap: {
            tags: topTags.map((t) => t.tagName),
            categories,
            cells: topTags.map((t) => heatmaps.get(t.tagId) ?? []),
        },
    };
}

function primaryTopCategory(cells: number[], categories: Array<{ code: string }>): string | null {
    let best = -1;
    let bestVal = 0;
    cells.forEach((v, i) => {
        if (v > bestVal) {
            bestVal = v;
            best = i;
        }
    });
    return best >= 0 ? categories[best].code : null;
}
