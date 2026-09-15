/**
 * 批量变式响应解析单元测试（parseVariantBatchResponse）
 * 覆盖：正常多块解析、难度归一化（大小写/中文）、缺标签块丢弃、LaTeX 双转义还原、截断兜底
 */
import { describe, it, expect } from 'vitest';
import { parseVariantBatchResponse } from '@/lib/ai/schema';

describe('parseVariantBatchResponse', () => {
    it('应该解析多个完整 variant 块', () => {
        const text = `
<variant>
<difficulty>MEDIUM</difficulty>
<question_text>题目一</question_text>
<answer_text>答案一</answer_text>
<analysis>解析一</analysis>
</variant>
<variant>
<difficulty>HARD</difficulty>
<question_text>题目二</question_text>
<answer_text>答案二</answer_text>
<analysis>解析二</analysis>
</variant>
`;
        const items = parseVariantBatchResponse(text);
        expect(items).toHaveLength(2);
        expect(items[0]).toEqual({ difficulty: 'medium', questionText: '题目一', answerText: '答案一', analysis: '解析一' });
        expect(items[1]).toEqual({ difficulty: 'hard', questionText: '题目二', answerText: '答案二', analysis: '解析二' });
    });

    it('应该归一化难度大小写与中文', () => {
        const text = `
<variant>
<difficulty>Hard</difficulty>
<question_text>A</question_text>
<answer_text>B</answer_text>
<analysis>C</analysis>
</variant>
<variant>
<difficulty>简单</difficulty>
<question_text>A</question_text>
<answer_text>B</answer_text>
<analysis>C</analysis>
</variant>
`;
        const items = parseVariantBatchResponse(text);
        expect(items.map((i) => i.difficulty)).toEqual(['hard', 'easy']);
    });

    it('应该丢弃缺字段或空字段的块（宽松解析）', () => {
        const text = `
<variant>
<difficulty>MEDIUM</difficulty>
<question_text>缺答案的块</question_text>
</variant>
<variant>
<difficulty>UNKNOWN_LEVEL</difficulty>
<question_text>A</question_text>
<answer_text>B</answer_text>
<analysis>C</analysis>
</variant>
<variant>
<difficulty>EASY</difficulty>
<question_text></question_text>
<answer_text>B</answer_text>
<analysis>C</analysis>
</variant>
`;
        const items = parseVariantBatchResponse(text);
        expect(items).toHaveLength(0);
    });

    it('应该还原 LaTeX 双转义与 form feed（GLM 坑）', () => {
        const text = `
<variant>
<difficulty>MEDIUM</difficulty>
<question_text>计算 \\\\frac{1}{2}</question_text>
<answer_text>B</answer_text>
<analysis>C</analysis>
</variant>
`;
        // 源码字符串中 \\\\frac 经模板求值为字面 \\frac，解析后应还原为 \frac
        const items = parseVariantBatchResponse(text);
        expect(items[0].questionText).toBe('计算 \\frac{1}{2}');
    });

    it('analysis 闭合标签丢失但块完整时应兜底读到底（无尾标签杂质）', () => {
        const text = `
<variant>
<difficulty>HARD</difficulty>
<question_text>题目</question_text>
<answer_text>答案</answer_text>
<analysis>解析到一半
</variant>
`;
        const items = parseVariantBatchResponse(text);
        expect(items).toHaveLength(1);
        expect(items[0].analysis).toBe('解析到一半');
    });

    it('块被整体截断（无闭合 variant 标签）时整块丢弃', () => {
        const text = `
<variant>
<difficulty>HARD</difficulty>
<question_text>题目</question_text>
<answer_text>答案</answer_text>
<analysis>解析到一半被 max_tokens 截断`;
        expect(parseVariantBatchResponse(text)).toHaveLength(0);
    });

    it('无 variant 块时返回空数组', () => {
        expect(parseVariantBatchResponse('随便一段没有标签的文本')).toEqual([]);
        expect(parseVariantBatchResponse('')).toEqual([]);
    });
});
