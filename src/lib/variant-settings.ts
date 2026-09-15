/**
 * 变式自动生成配置（User.variantSettings JSON 的解析与校验）：
 * enabled=错题入库后自动生成；perDifficulty=各难度数量（0 表示该档不生成）。
 * 难度语义映射：easy=简单、medium=适中、hard=困难、harder=挑战。
 */

import type { DifficultyLevel } from "@/lib/ai/types";

export interface VariantSettings {
    /** 错题入库后自动生成变式（默认关闭，避免意外触发大量 AI 调用） */
    enabled: boolean;
    /** 各难度生成数量（0-5） */
    perDifficulty: Record<DifficultyLevel, number>;
}

/** 全部难度档（顺序即默认展示序），单一来源供 generator/设置页/打印页复用 */
export const DIFFICULTY_LEVELS: DifficultyLevel[] = ["easy", "medium", "hard", "harder"];
const MAX_PER_DIFFICULTY = 5;

/** 每次返回全新默认值（perDifficulty 浅拷贝，防共享引用被改） */
export function defaultVariantSettings(): VariantSettings {
    return { enabled: false, perDifficulty: { easy: 0, medium: 1, hard: 2, harder: 1 } };
}

export const DEFAULT_VARIANT_SETTINGS: VariantSettings = defaultVariantSettings();

/** 界面用的难度展示（顺序即 UI 顺序） */
export const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = {
    easy: "简单",
    medium: "适中",
    hard: "困难",
    harder: "挑战",
};

export function parseVariantSettings(raw: unknown): VariantSettings {
    let obj: unknown = raw;
    if (typeof raw === "string") {
        try {
            obj = JSON.parse(raw);
        } catch {
            return defaultVariantSettings();
        }
    }
    if (typeof obj !== "object" || obj === null) {
        return defaultVariantSettings();
    }
    const o = obj as Partial<VariantSettings>;
    const perDifficulty = { ...DEFAULT_VARIANT_SETTINGS.perDifficulty };
    const rawPer = (o.perDifficulty ?? {}) as Record<string, unknown>;
    for (const level of DIFFICULTY_LEVELS) {
        const n = rawPer[level];
        if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_PER_DIFFICULTY) {
            perDifficulty[level] = n;
        }
    }
    return { enabled: o.enabled === true, perDifficulty };
}

export function serializeVariantSettings(s: VariantSettings): string {
    return JSON.stringify(s);
}

/** 配置的总生成数量（0 = 无需生成） */
export function totalVariantCount(s: VariantSettings): number {
    return DIFFICULTY_LEVELS.reduce((sum, level) => sum + (s.perDifficulty[level] ?? 0), 0);
}

/** 补齐进度（variant-generator 进程内状态，经 settings 接口透出给前端轮询） */
export interface VariantProgress {
    active: boolean;
    total: number; // 本轮计划处理的错题数（含重试轮）
    done: number; // 已处理完成（含失败）的错题数
}
