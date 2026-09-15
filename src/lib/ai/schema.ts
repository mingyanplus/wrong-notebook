import { z } from 'zod';
import { ERROR_CATEGORIES, ErrorCategoryCode, parseErrorCategoryCode, parseSecondaryCategories, parseQuestionTypeCode } from '../error-categories';
import type { BackfillMetaResult, DifficultyLevel } from './types';

const CATEGORY_CODES = [...ERROR_CATEGORIES.map((c) => c.code)] as [ErrorCategoryCode, ...ErrorCategoryCode[]];
// 主错因枚举额外允许 "unknown"（无学生作答时 AI 无法判定）
const CATEGORY_CODES_OR_UNKNOWN = ["unknown", ...CATEGORY_CODES] as ["unknown", ErrorCategoryCode, ...ErrorCategoryCode[]];

/**
 * Zod schema for validating AI-parsed questions
 * Ensures type safety and business rule compliance
 */
export const ParsedQuestionSchema = z.object({
    questionText: z.string().min(1, "题目文本不能为空"),
    answerText: z.string().min(1, "答案不能为空"),
    analysis: z.string().min(1, "解析不能为空"),
    wrongAnswerText: z.string().optional().default(""),
    mistakeAnalysis: z.string().optional().default(""),
    mistakeStatus: z.enum(["not_attempted", "wrong_attempt", "unknown"]).optional().default("unknown"),
    subject: z.enum([
        "数学", "物理", "化学", "生物",
        "英语", "语文", "历史", "地理",
        "政治", "其他"
    ]),
    knowledgePoints: z.array(z.string()).max(5, "知识点最多 5 个"),
    requiresImage: z.boolean().optional().default(false), // 题目是否依赖图片（如几何题）
    // 结构化错因（AI 判定，编辑器确认）
    errorCategory: z.enum(CATEGORY_CODES_OR_UNKNOWN).optional().default("unknown"),
    secondaryErrorCategories: z.array(z.enum(CATEGORY_CODES)).max(2, "次错因最多 2 个").optional().default([]),
    questionType: z.enum(["choice", "fill", "solve", "judge"]).optional().default("solve"),
});

/**
 * Type inference from Zod schema
 * Use this type instead of manually defining ParsedQuestion
 */
export type ParsedQuestionFromSchema = z.infer<typeof ParsedQuestionSchema>;

/**
 * Validates and parses AI response JSON
 * @param data - Raw JSON data from AI
 * @returns Validated ParsedQuestion object
 * @throws ZodError if validation fails
 */
export function validateParsedQuestion(data: unknown): ParsedQuestionFromSchema {
    return ParsedQuestionSchema.parse(data);
}

/**
 * Safe validation that returns success/error object
 * @param data - Raw JSON data from AI
 */
export function safeParseParsedQuestion(data: unknown) {
    return ParsedQuestionSchema.safeParse(data);
}

/**
 * 还原 AI 输出的 LaTeX 转义问题：
 * 1. 偶发输出的 JSON 风格双反斜杠转义（\\frac → \frac）。仅匹配「\\ + 命令字母」的组合；
 *    LaTeX 合法的换行命令 \\ 后面不会直接跟字母，不受影响。
 * 2. 被某层 JSON 解析吞掉的 \f 转义：\f 是 JSON 合法转义（form feed 控制字符 \x0C），
 *    AI 半转义输出 "\frac" 时 JSON.parse 不报错而静默吞掉反斜杠和 f（剩 "\x0Crac" 显示为 rac）。
 *    题目正文不会出现字面 form feed，还原为字面 \f 零误伤（\x0Crac → \frac）。
 */
export function normalizeLatexEscapes(text: string): string {
    return text
        .replace(/\\\\(?=[a-zA-Z])/g, '\\')
        .replace(/\f/g, '\\f');
}

/**
 * 通用 XML 标签提取（取第一个开始标签到最后一个结束标签之间的内容），解析与测试共用。
 * 特殊兜底：闭合标签丢失且为 analysis 时读到字符串末尾（输出被 max_tokens 截断时，
 * 最后一个块的 analysis 标签常被截掉；批量多题输出尤甚）。
 */
export function extractTag(text: string, tagName: string): string | null {
    const startTag = `<${tagName}>`;
    const endTag = `</${tagName}>`;
    const startIndex = text.indexOf(startTag);
    if (startIndex === -1) return null;

    const contentStartIndex = startIndex + startTag.length;
    const endIndex = text.lastIndexOf(endTag);

    if (endIndex === -1 && tagName === "analysis") {
        return normalizeLatexEscapes(text.substring(contentStartIndex).trim());
    }
    if (endIndex === -1 || contentStartIndex >= endIndex) {
        return null;
    }
    return normalizeLatexEscapes(text.substring(contentStartIndex, endIndex).trim());
}

/**
 * 解析扫图批改的 XML 标签响应（三个 Provider 共享；provider 仅传入各自的 extractTag）。
 * is_correct 仅在明确输出 "true" 时判对（缺标签/胡乱填写一律判错，保守不推进掌握度）。
 */
export function parseGradeResponse(
    text: string,
    extractTag: (text: string, tagName: string) => string | null
): { isCorrect: boolean; comment: string } {
    const isCorrectRaw = extractTag(text, "is_correct")?.trim().toLowerCase();
    const comment = extractTag(text, "comment")?.trim() ?? "";
    return {
        isCorrect: isCorrectRaw === "true",
        comment: normalizeLatexEscapes(comment),
    };
}

/**
 * 解析 backfillMeta 的 XML 标签响应（三个 Provider 共享；provider 仅传入各自的 extractTag）
 */
export function parseBackfillResponse(
    text: string,
    extractTag: (text: string, tagName: string) => string | null
): BackfillMetaResult {
    const knowledgePointsRaw = extractTag(text, "knowledge_points") || "";
    const errorCategory = parseErrorCategoryCode(extractTag(text, "error_category"));
    // 仅 true/false 明确输出时返回布尔，其余（缺标签/胡乱填写）返回 undefined 供调用方跳过不覆盖
    const requiresImageRaw = extractTag(text, "requires_image")?.toLowerCase().trim();
    return {
        knowledgePoints: knowledgePointsRaw
            .split(/[,，\n]/)
            .map((k) => k.trim())
            .filter((k) => k.length > 0)
            .slice(0, 5),
        questionType: parseQuestionTypeCode(extractTag(text, "question_type")),
        errorCategory,
        secondaryErrorCategories: parseSecondaryCategories(extractTag(text, "secondary_error_categories"), errorCategory),
        requiresImage: requiresImageRaw === "true" ? true : requiresImageRaw === "false" ? false : undefined,
    };
}

/** 批量变式生成结果的单条变式（变式题库/智能组卷共用） */
export interface VariantBatchItem {
    difficulty: DifficultyLevel;
    questionText: string;
    answerText: string;
    analysis: string;
}

/** 难度归一化：接受模板要求的大写 code，宽松兼容小写/中文 */
const VARIANT_DIFFICULTY_MAP: Record<string, VariantBatchItem['difficulty']> = {
    EASY: 'easy', MEDIUM: 'medium', HARD: 'hard', HARDER: 'harder',
    简单: 'easy', 适中: 'medium', 困难: 'hard', 挑战: 'harder',
};

/**
 * 解析批量变式的 XML 标签响应。
 * 每道题一个 <variant> 块，块内含 difficulty/question_text/answer_text/analysis。
 * 宽松解析：缺标签/难度无法识别/字段为空的块直接丢弃，能解析几道返回几道，
 * 缺口由调用方（variant-generator 多轮补齐 / 组卷降级原题）兜底。
 */
export function parseVariantBatchResponse(text: string): VariantBatchItem[] {
    // 取 <variant> 块内层（捕获组），analysis 截断兜底读到内层末尾时不会吃进尾标签
    const blockRe = /<variant>([\s\S]*?)<\/variant>/g;
    const items: VariantBatchItem[] = [];
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(text)) !== null) {
        const block = m[1];
        const difficulty = VARIANT_DIFFICULTY_MAP[(extractTag(block, 'difficulty') ?? '').toUpperCase()] ?? null;
        const questionText = extractTag(block, 'question_text') ?? '';
        const answerText = extractTag(block, 'answer_text') ?? '';
        const analysis = extractTag(block, 'analysis') ?? '';
        if (!difficulty || !questionText || !answerText || !analysis) continue;
        items.push({ difficulty, questionText, answerText, analysis });
    }
    return items;
}
