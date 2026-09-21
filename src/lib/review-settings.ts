/**
 * 用户复习设置（User.reviewSettings JSON 的解析与校验）：
 * dailyLimit 每日复习数量上限（null=不限）；errorCategories 重点复习的错因勾选（null=不过滤）。
 */

import { ERROR_CATEGORIES } from "@/lib/error-categories";

export interface ReviewSettings {
    /** 每日复习数量上限，null = 不限（接口侧仍有安全上限兜底） */
    dailyLimit: number | null;
    /** 重点复习的错因 code 列表（如 ["stuck", "concept"]），null = 不过滤 */
    errorCategories: string[] | null;
}

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = { dailyLimit: null, errorCategories: null };

/** 每日复习数量上限（校验与接口兜底共用同一约束，避免两处硬编码漂移） */
export const MAX_DAILY_LIMIT = 500;

/** 勾选「未分类」时的哨兵值：复习错因筛选同时包含没有错因的题（如做不来但当时没录错因） */
export const UNCATEGORIZED_SENTINEL = "uncategorized";

/** 到期复习列表排序模式（前后端共享单一来源，避免字面量多处漂移）：asc 掌握度低+到期早优先（默认）；desc 反向；random 确定性乱序；tag 前端按知识点分组 */
export const DUE_SORT_MODES = ["asc", "desc", "random", "tag"] as const;
export type DueSortMode = (typeof DUE_SORT_MODES)[number];

/** 解析到期列表排序参数：非法值一律回退默认 asc */
export function parseDueSortMode(raw: string | null): DueSortMode {
    return raw === "desc" || raw === "random" || raw === "tag" ? raw : "asc";
}

const validCodes = new Set<string>([...ERROR_CATEGORIES.map((c) => c.code as string), UNCATEGORIZED_SENTINEL]);

/**
 * 解析复习设置（接受 JSON 字符串、对象、null/undefined；损坏/缺省时回退默认值，无效字段静默丢弃）。
 * GET 侧传库中 JSON 字符串，PUT 侧直接传请求体对象——读写共用同一套校验。
 */
export function parseReviewSettings(raw: unknown): ReviewSettings {
    let obj: unknown = raw;
    if (typeof raw === "string") {
        try {
            obj = JSON.parse(raw);
        } catch {
            return DEFAULT_REVIEW_SETTINGS;
        }
    }
    if (typeof obj !== "object" || obj === null) {
        return DEFAULT_REVIEW_SETTINGS;
    }
    const o = obj as Partial<ReviewSettings>;
    const dailyLimit =
        typeof o.dailyLimit === "number" && Number.isInteger(o.dailyLimit) && o.dailyLimit >= 1 && o.dailyLimit <= MAX_DAILY_LIMIT
            ? o.dailyLimit
            : null;
    const cats = Array.isArray(o.errorCategories)
        ? o.errorCategories.filter((c): c is string => typeof c === "string" && validCodes.has(c))
        : null;
    return { dailyLimit, errorCategories: cats && cats.length > 0 ? cats : null };
}

export function serializeReviewSettings(s: ReviewSettings): string {
    return JSON.stringify(s);
}

export function isSameReviewSettings(a: ReviewSettings, b: ReviewSettings): boolean {
    return a.dailyLimit === b.dailyLimit && (a.errorCategories ?? []).join(",") === (b.errorCategories ?? []).join(",");
}
