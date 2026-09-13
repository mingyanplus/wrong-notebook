/**
 * 试卷题目排序（纯前端视图调整，不落库）：
 * 默认（组卷序）/ 按知识点（同知识点相邻）/ 按错因类型 / 随机打乱（seed 控制，重渲染不跳变）。
 * 大题结构（选择→填空→判断→解答）保留，排序只在大题内部进行。
 */

import { ERROR_CATEGORIES } from "@/lib/error-categories";
import { parseLegacyKnowledgePoints } from "@/lib/knowledge-tags";

export type PaperSortMode = "default" | "knowledge" | "error" | "shuffle";

export interface SortablePaperQuestion {
    id: string;
    order: number;
    section: string;
    /** JSON 数组字符串，如 ["勾股定理", "相似三角形"] */
    knowledgePoints: string | null;
    /** 源错题主错因 code（变式题为 null），见 src/lib/error-categories.ts */
    errorCategory: string | null;
}

/** mulberry32 伪随机数生成器：同 seed 同结果，保证洗牌结果在重渲染间稳定 */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function firstKnowledgePoint(q: SortablePaperQuestion): string {
    return parseLegacyKnowledgePoints(q.knowledgePoints)[0] ?? "";
}

/** 错因排序序：按错因体系定义顺序（概念不清在前），无错因/未知 code 一律排最后 */
const ERROR_ORDER = new Map<string, number>(ERROR_CATEGORIES.map((c, i) => [c.code as string, i]));

function errorRank(q: SortablePaperQuestion): number {
    return ERROR_ORDER.get(q.errorCategory ?? "") ?? ERROR_CATEGORIES.length + 1;
}

/**
 * 按大题分组并在组内排序，返回 Map<section, questions[]>（组间保持首现顺序，即组卷时的题型顺序）。
 * shuffle 模式各大题用 seed + 组序号 派生独立随机流，同 seed 结果可复现。
 */
export function sortPaperQuestions<T extends SortablePaperQuestion>(
    questions: T[],
    mode: PaperSortMode,
    seed: number
): Map<string, T[]> {
    const grouped = new Map<string, T[]>();
    for (const q of questions) {
        const list = grouped.get(q.section) ?? [];
        list.push(q);
        grouped.set(q.section, list);
    }
    let sectionIndex = 0;
    for (const [section, list] of grouped) {
        let sorted: T[];
        switch (mode) {
            case "knowledge":
                sorted = [...list].sort((a, b) => {
                    const ka = firstKnowledgePoint(a);
                    const kb = firstKnowledgePoint(b);
                    if (!ka && kb) return 1; // 无知识点排最后
                    if (ka && !kb) return -1;
                    return ka.localeCompare(kb, "zh-Hans-CN") || a.order - b.order;
                });
                break;
            case "error":
                sorted = [...list].sort((a, b) => errorRank(a) - errorRank(b) || a.order - b.order);
                break;
            case "shuffle": {
                const rng = mulberry32(seed + sectionIndex * 7919);
                sorted = [...list];
                for (let i = sorted.length - 1; i > 0; i--) {
                    const j = Math.floor(rng() * (i + 1));
                    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
                }
                break;
            }
            default:
                sorted = [...list].sort((a, b) => a.order - b.order);
        }
        grouped.set(section, sorted);
        sectionIndex++;
    }
    return grouped;
}
