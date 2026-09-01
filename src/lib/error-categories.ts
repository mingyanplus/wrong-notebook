/**
 * 结构化错因体系（grilling 定案 2026-09-01）
 * 核心 8 类 + 学科扩展；主错因权重 1.0，次错因权重 0.5
 * 权重供薄弱度模型使用：知识性错因 > 操作性错因
 */

export type ErrorCategoryCode =
    // 核心错因
    | "concept"      // 概念不清
    | "formula"      // 公式记错
    | "calculation"  // 计算失误
    | "misread"      // 审题偏差
    | "method"       // 方法选择错误
    | "stuck"        // 思路卡壳
    | "expression"   // 表述不规范
    | "careless"     // 粗心/时间不足
    // 学科扩展
    | "vocab"        // 英语：词义混淆
    | "trap"         // 语文：设错点误判
    | "recall";      // 政史地：记忆性错误

export interface ErrorCategoryDef {
    code: ErrorCategoryCode;
    label: string;
    /** 判定标准（供 AI 提示词使用） */
    criteria: string;
    /** 薄弱度权重：知识性错因 1.5，操作性错因 0.7，其余 1.0 */
    weight: number;
    /** 仅适用于这些学科（null = 全学科） */
    subjects: string[] | null;
}

const SUBJECT_ALIASES: Record<string, string> = {
    "英语": "english", "语文": "chinese", "数学": "math",
    "物理": "physics", "化学": "chemistry", "生物": "biology",
    "历史": "history", "地理": "geography", "政治": "politics",
};

export const ERROR_CATEGORIES: ErrorCategoryDef[] = [
    { code: "concept", label: "概念不清", criteria: "定义/定理/性质理解错误", weight: 1.5, subjects: null },
    { code: "formula", label: "公式记错", criteria: "公式本身回忆错误", weight: 1.5, subjects: null },
    { code: "calculation", label: "计算失误", criteria: "思路对但算错", weight: 0.7, subjects: null },
    { code: "misread", label: "审题偏差", criteria: "漏条件、理解错题意", weight: 1.0, subjects: null },
    { code: "method", label: "方法选择错误", criteria: "用错方法或绕远路", weight: 1.5, subjects: null },
    { code: "stuck", label: "思路卡壳", criteria: "无从下手、卡在关键步骤", weight: 1.5, subjects: null },
    { code: "expression", label: "表述不规范", criteria: "会做但过程/格式丢分", weight: 1.0, subjects: null },
    { code: "careless", label: "粗心/时间不足", criteria: "抄错数、看错、没做完", weight: 0.7, subjects: null },
    { code: "vocab", label: "词义混淆", criteria: "单词/短语含义记错或混淆", weight: 1.0, subjects: ["english"] },
    { code: "trap", label: "设错点误判", criteria: "选择题设错点识别错误（情感判断偏差、细节理解错误等）", weight: 1.0, subjects: ["chinese"] },
    { code: "recall", label: "记忆性错误", criteria: "史实/地名/原理等知识点记忆错误", weight: 1.0, subjects: ["history", "geography", "politics"] },
];

export function getErrorCategory(code: string): ErrorCategoryDef | undefined {
    return ERROR_CATEGORIES.find((c) => c.code === code);
}

export function getErrorCategoryLabel(code: string | null | undefined): string {
    if (!code) return "未分类";
    return getErrorCategory(code)?.label ?? code;
}

/** 获取某学科可用的错因列表（学科名支持中文或英文 key） */
export function getCategoriesForSubject(subjectName?: string | null): ErrorCategoryDef[] {
    if (!subjectName) return ERROR_CATEGORIES.filter((c) => c.subjects === null);
    const key = SUBJECT_ALIASES[subjectName] ?? subjectName.toLowerCase();
    return ERROR_CATEGORIES.filter((c) => c.subjects === null || c.subjects.includes(key));
}

// ── 题型（组卷大题分组使用）──────────────────────────────

export type QuestionTypeCode = "choice" | "fill" | "solve" | "judge";

// 顺序即组卷大题顺序：选择 → 填空 → 判断 → 解答
export const QUESTION_TYPES: Array<{ code: QuestionTypeCode; label: string; defaultScore: number }> = [
    { code: "choice", label: "选择题", defaultScore: 3 },
    { code: "fill", label: "填空题", defaultScore: 3 },
    { code: "judge", label: "判断题", defaultScore: 3 },
    { code: "solve", label: "解答题", defaultScore: 10 },
];

export function getQuestionTypeLabel(code: string | null | undefined): string {
    if (!code) return "解答题";
    return QUESTION_TYPES.find((t) => t.code === code)?.label ?? "解答题";
}

// ── AI 输出解析（供各 Provider 复用）──────────────────────

/** 解析 AI 输出的主错因 code，无效/缺失归一为 "unknown" */
export function parseErrorCategoryCode(raw: string | null | undefined): ErrorCategoryCode | "unknown" {
    if (!raw) return "unknown";
    const code = raw.trim().toLowerCase();
    return getErrorCategory(code) ? (code as ErrorCategoryCode) : "unknown";
}

/** 解析次错因（逗号分隔），过滤无效值、去重去主错因，最多 2 个 */
export function parseSecondaryCategories(raw: string | null | undefined, primary: string | undefined): ErrorCategoryCode[] {
    if (!raw) return [];
    const codes = raw
        .split(/[,，\n]/)
        .map((c) => c.trim().toLowerCase())
        .filter((c): c is ErrorCategoryCode => !!c && c !== primary && !!getErrorCategory(c));
    return Array.from(new Set<ErrorCategoryCode>(codes)).slice(0, 2);
}

/** 解析题型 code，无效值归一为 "solve" */
export function parseQuestionTypeCode(raw: string | null | undefined): QuestionTypeCode {
    if (raw === "choice" || raw === "fill" || raw === "judge") return raw;
    return "solve";
}

// ── secondaryErrorCategories 的 JSON 序列化/反序列化（单一实现，各 API 路由复用）──

/** 序列化次错因为 JSON 字符串（过滤非字符串、截断到最多 2 个）；非数组输入返回 null */
export function serializeSecondaryCategories(codes: unknown): string | null {
    if (!Array.isArray(codes)) return null;
    return JSON.stringify(codes.filter((c): c is string => typeof c === "string").slice(0, 2));
}

/** 容错解析 secondaryErrorCategories JSON 字符串为数组（非法输入返回空数组） */
export function parseSecondaryCategoriesJson(json: string | null | undefined): string[] {
    if (!json) return [];
    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
    } catch {
        return [];
    }
}

// ── AI 提示词用的错因目录拼装（由 ERROR_CATEGORIES 派生，避免提示词手抄目录）──

const SUBJECT_LABELS: Record<string, string> = { english: "英语", chinese: "语文", history: "历史", geography: "地理", politics: "政治" };

/** 拼装错因 code 目录指令串（核心 + 可选学科扩展），供 analyze/backfill 提示词注入 */
export function buildErrorCategoryInstruction(subject?: string | null): string {
    const categories = getCategoriesForSubject(subject);
    const subjectExtras = ERROR_CATEGORIES.filter((c) => c.subjects !== null && !categories.includes(c));
    const lines = [
        `填写以下 code 之一：${categories.map((c) => `${c.code}（${c.label}：${c.criteria}）`).join("、")}。`,
    ];
    if (subjectExtras.length > 0) {
        lines.push(
            subjectExtras
                .map((c) => `${(c.subjects ?? []).map((s) => SUBJECT_LABELS[s] ?? s).join("/")}题可用：${c.code}（${c.label}）`)
                .join("。") + "。"
        );
    }
    lines.push("如果没有学生作答、无法判断错误原因，填写 unknown。");
    return lines.join("\n");
}
