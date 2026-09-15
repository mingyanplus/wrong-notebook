// Re-export the Zod-validated type from schema.ts
export type { ParsedQuestionFromSchema as ParsedQuestion, VariantBatchItem } from './schema';
import type { ParsedQuestionFromSchema, VariantBatchItem } from './schema';

// Import and re-export MistakeStatus from the single source of truth
import type { MistakeStatus } from '../mistake-status';
export type { MistakeStatus };

export type DifficultyLevel = 'easy' | 'medium' | 'hard' | 'harder';

export interface ReanswerQuestionResult {
    answerText: string;
    analysis: string;
    knowledgePoints: string[];
    wrongAnswerText: string;
    mistakeAnalysis: string;
    mistakeStatus: MistakeStatus;
    // 手动输入流程补充（AI 重解时可能携带的错因/题型判定）
    errorCategory?: string;
    secondaryErrorCategories?: string[];
    questionType?: string;
}

export interface GeogebraAnalysisResult {
    suitable: boolean;
    commands: string[];
    description: string;
}

/** 批量补全元数据结果（B4：标签 + 题型 + 错因） */
export interface BackfillMetaResult {
    knowledgePoints: string[];
    questionType: "choice" | "fill" | "solve" | "judge";
    errorCategory: string; // code 或 "unknown"
    secondaryErrorCategories: string[];
    requiresImage?: boolean; // AI 按题干文本判断是否必须看图；undefined=未输出（不覆盖已有值）
}

/** 扫图批改入参：图片与手动输入的作答文字至少提供其一 */
export interface GradeAnswerInput {
    /** 作答图片（base64 或 data URL） */
    imageBase64?: string;
    /** 手动输入的学生作答文字（图片识别不佳时的兜底） */
    studentAnswer?: string;
}

/** 扫图批改结果（复习卷闭环三期）：对/错判定 + 家长向点评 */
export interface GradeAnswerResult {
    isCorrect: boolean;
    comment: string;
}

export interface AIService {
    analyzeImage(imageBase64: string, mimeType?: string, language?: 'zh' | 'en', grade?: 7 | 8 | 9 | 10 | 11 | 12 | null, subject?: string | null, gradeSemester?: string | null): Promise<ParsedQuestionFromSchema>;
    generateSimilarQuestion(originalQuestion: string, knowledgePoints: string[], language?: 'zh' | 'en', difficulty?: DifficultyLevel, gradeSemester?: string | null, mistakeHint?: string): Promise<ParsedQuestionFromSchema>;
    /** 批量变式：一次请求按清单生成多道不同难度的变式题（解构思考成本只付一次） */
    generateSimilarQuestions(originalQuestion: string, knowledgePoints: string[], requests: Array<{ difficulty: DifficultyLevel; count: number }>, language?: 'zh' | 'en', gradeSemester?: string | null, mistakeHint?: string): Promise<VariantBatchItem[]>;
    reanswerQuestion(questionText: string, language?: 'zh' | 'en', subject?: string | null, imageBase64?: string, gradeSemester?: string | null): Promise<ReanswerQuestionResult>;
    analyzeForGeogebra(questionText: string, answerText: string, analysis: string, previousErrors?: string): Promise<GeogebraAnalysisResult>;
    backfillMeta(questionText: string, answerText?: string, analysis?: string, wrongAnswerText?: string, subject?: string | null, tagList?: string): Promise<BackfillMetaResult>;
    gradeAnswer(questionText: string, answerText: string, input: GradeAnswerInput, language?: 'zh' | 'en', gradeSemester?: string | null): Promise<GradeAnswerResult>;
}

export interface AIConfig {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    // Azure OpenAI 特有字段
    azureDeployment?: string;   // Azure 部署名称
    azureApiVersion?: string;   // API 版本 (如 2024-02-15-preview)
}
