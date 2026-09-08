/**
 * AI Schema 单元测试
 *
 * 测试 Zod 验证 schema，特别是新增的错因分析字段
 */
import { describe, it, expect } from 'vitest';
import { ParsedQuestionSchema, safeParseParsedQuestion, normalizeLatexEscapes } from '@/lib/ai/schema';

describe('ParsedQuestionSchema 验证', () => {
    const validBaseQuestion = {
        questionText: '求解方程 2x + 3 = 7',
        answerText: 'x = 2',
        analysis: '移项后计算得出 x = 2',
        subject: '数学',
        knowledgePoints: ['一元一次方程'],
        requiresImage: false,
    };

    describe('基础字段验证', () => {
        it('应该接受有效的基础题目数据', () => {
            const result = ParsedQuestionSchema.safeParse(validBaseQuestion);
            expect(result.success).toBe(true);
        });

        it('questionText 不能为空', () => {
            const result = ParsedQuestionSchema.safeParse({
                ...validBaseQuestion,
                questionText: '',
            });
            expect(result.success).toBe(false);
        });

        it('answerText 不能为空', () => {
            const result = ParsedQuestionSchema.safeParse({
                ...validBaseQuestion,
                answerText: '',
            });
            expect(result.success).toBe(false);
        });

        it('analysis 不能为空', () => {
            const result = ParsedQuestionSchema.safeParse({
                ...validBaseQuestion,
                analysis: '',
            });
            expect(result.success).toBe(false);
        });
    });

    describe('错因分析字段验证', () => {
        it('应该接受包含完整错因分析的数据', () => {
            const result = ParsedQuestionSchema.safeParse({
                ...validBaseQuestion,
                wrongAnswerText: 'x = 4',
                mistakeAnalysis: '计算错误',
                mistakeStatus: 'wrong_attempt',
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.wrongAnswerText).toBe('x = 4');
                expect(result.data.mistakeAnalysis).toBe('计算错误');
                expect(result.data.mistakeStatus).toBe('wrong_attempt');
            }
        });

        it('错因字段缺失时应该使用默认值', () => {
            const result = ParsedQuestionSchema.safeParse(validBaseQuestion);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.wrongAnswerText).toBe('');
                expect(result.data.mistakeAnalysis).toBe('');
                expect(result.data.mistakeStatus).toBe('unknown');
            }
        });

        it('mistakeStatus 只接受合法值', () => {
            const validStatuses = ['not_attempted', 'wrong_attempt', 'unknown'];

            validStatuses.forEach(status => {
                const result = ParsedQuestionSchema.safeParse({
                    ...validBaseQuestion,
                    mistakeStatus: status,
                });
                expect(result.success).toBe(true);
            });
        });

        it('mistakeStatus 拒绝非法值', () => {
            const result = ParsedQuestionSchema.safeParse({
                ...validBaseQuestion,
                mistakeStatus: 'invalid_status',
            });
            expect(result.success).toBe(false);
        });

        it('wrongAnswerText 可以为空字符串', () => {
            const result = ParsedQuestionSchema.safeParse({
                ...validBaseQuestion,
                wrongAnswerText: '',
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.wrongAnswerText).toBe('');
            }
        });

        it('mistakeAnalysis 可以为空字符串', () => {
            const result = ParsedQuestionSchema.safeParse({
                ...validBaseQuestion,
                mistakeAnalysis: '',
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.mistakeAnalysis).toBe('');
            }
        });
    });

    describe('safeParseParsedQuestion', () => {
        it('应该安全解析有效数据', () => {
            const result = safeParseParsedQuestion(validBaseQuestion);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.questionText).toBe(validBaseQuestion.questionText);
            }
        });

        it('应该安全解析包含错因的数据', () => {
            const dataWithMistake = {
                ...validBaseQuestion,
                wrongAnswerText: 'x = 4',
                mistakeStatus: 'wrong_attempt',
            };
            const result = safeParseParsedQuestion(dataWithMistake);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.wrongAnswerText).toBe('x = 4');
                expect(result.data.mistakeStatus).toBe('wrong_attempt');
            }
        });

        it('无效数据应该返回失败结果', () => {
            const result = safeParseParsedQuestion({
                ...validBaseQuestion,
                questionText: '',
            });
            expect(result.success).toBe(false);
        });
    });
});

describe('normalizeLatexEscapes', () => {
    it('应还原 AI 偶发的双反斜杠 LaTeX 转义（生产实测案例）', () => {
        const escaped = String.raw`$$\\frac{2}{1+2}\\times\\frac{2+3}{1+2+3}\\times\\cdots\\times\\frac{2+3+\\cdots+50}{1+2+3+\\cdots+50}$$`;
        const expected = String.raw`$$\frac{2}{1+2}\times\frac{2+3}{1+2+3}\times\cdots\times\frac{2+3+\cdots+50}{1+2+3+\cdots+50}$$`;
        expect(normalizeLatexEscapes(escaped)).toBe(expected);
    });

    it('正常的单反斜杠 LaTeX 不应被改动', () => {
        const normal = String.raw`$\frac{1}{3}+\frac{1}{3+6}+\cdots+\frac{1}{3+6+9+\cdots+99}$`;
        expect(normalizeLatexEscapes(normal)).toBe(normal);
    });

    it('LaTeX 换行命令 \\\\（含带间距的 \\\\[2pt]）应保持不变', () => {
        const multiline = String.raw`\begin{aligned} x &= 1 \\ y &= 2 \\[2pt] z &= 3 \end{aligned}`;
        expect(normalizeLatexEscapes(multiline)).toBe(multiline);
    });

    it('无公式的纯文本不应被改动', () => {
        const plain = '解：先通分再相加，注意运算顺序。';
        expect(normalizeLatexEscapes(plain)).toBe(plain);
        expect(normalizeLatexEscapes('')).toBe('');
    });
});
