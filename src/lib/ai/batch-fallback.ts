/**
 * 批量变式的单题回退：配置了自定义单题模板（config.prompts.similar）时，
 * 批量清单展开为逐题单题调用（用户模板是单题语义，没有 {{batch_request_list}} 等批量变量，
 * 不能直接渲染进批量路径）。三个 Provider 共享，避免退化策略三处漂移。
 */
import type { AIService, DifficultyLevel, VariantBatchItem } from './types';

export async function generateVariantsViaSingles(
    generateOne: AIService['generateSimilarQuestion'],
    originalQuestion: string,
    knowledgePoints: string[],
    requests: Array<{ difficulty: DifficultyLevel; count: number }>,
    language: 'zh' | 'en',
    gradeSemester?: string | null,
    mistakeHint?: string
): Promise<VariantBatchItem[]> {
    const results: VariantBatchItem[] = [];
    for (const { difficulty, count } of requests) {
        for (let i = 0; i < count; i++) {
            const q = await generateOne(originalQuestion, knowledgePoints, language, difficulty, gradeSemester, mistakeHint);
            results.push({ difficulty, questionText: q.questionText, answerText: q.answerText, analysis: q.analysis });
        }
    }
    return results;
}
