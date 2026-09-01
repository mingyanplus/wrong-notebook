import { z } from 'zod';
import { ERROR_CATEGORIES, ErrorCategoryCode, parseErrorCategoryCode, parseSecondaryCategories, parseQuestionTypeCode } from '../error-categories';

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
 * 解析 backfillMeta 的 XML 标签响应（三个 Provider 共享；provider 仅传入各自的 extractTag）
 */
export function parseBackfillResponse(
    text: string,
    extractTag: (text: string, tagName: string) => string | null
): { knowledgePoints: string[]; questionType: "choice" | "fill" | "solve" | "judge"; errorCategory: string; secondaryErrorCategories: string[] } {
    const knowledgePointsRaw = extractTag(text, "knowledge_points") || "";
    const errorCategory = parseErrorCategoryCode(extractTag(text, "error_category"));
    return {
        knowledgePoints: knowledgePointsRaw
            .split(/[,，\n]/)
            .map((k) => k.trim())
            .filter((k) => k.length > 0)
            .slice(0, 5),
        questionType: parseQuestionTypeCode(extractTag(text, "question_type")),
        errorCategory,
        secondaryErrorCategories: parseSecondaryCategories(extractTag(text, "secondary_error_categories"), errorCategory),
    };
}
