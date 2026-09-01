/**
 * 结构化错因体系单元测试
 */
import { describe, it, expect } from 'vitest';
import {
    ERROR_CATEGORIES,
    getCategoriesForSubject,
    getErrorCategoryLabel,
    parseErrorCategoryCode,
    parseSecondaryCategories,
    parseQuestionTypeCode,
} from '@/lib/error-categories';

describe('error-categories 错因体系', () => {
    describe('getCategoriesForSubject', () => {
        it('无学科时只返回核心类别', () => {
            const codes = getCategoriesForSubject(null).map((c) => c.code);
            expect(codes).not.toContain('vocab');
            expect(codes).not.toContain('trap');
            expect(codes).not.toContain('recall');
            expect(codes).toContain('concept');
        });

        it('英语包含 vocab，排除 trap', () => {
            const codes = getCategoriesForSubject('英语').map((c) => c.code);
            expect(codes).toContain('vocab');
            expect(codes).not.toContain('trap');
        });

        it('支持英文别名', () => {
            expect(getCategoriesForSubject('english').map((c) => c.code)).toContain('vocab');
            expect(getCategoriesForSubject('history').map((c) => c.code)).toContain('recall');
        });
    });

    describe('parseErrorCategoryCode', () => {
        it('有效 code 原样返回', () => {
            expect(parseErrorCategoryCode('concept')).toBe('concept');
            expect(parseErrorCategoryCode(' Concept ')).toBe('concept');
        });

        it('无效/缺失归一为 unknown', () => {
            expect(parseErrorCategoryCode(null)).toBe('unknown');
            expect(parseErrorCategoryCode('')).toBe('unknown');
            expect(parseErrorCategoryCode('nonsense')).toBe('unknown');
        });
    });

    describe('parseSecondaryCategories', () => {
        it('逗号分隔解析并过滤无效值', () => {
            expect(parseSecondaryCategories('calculation, nonsense，misread', 'concept'))
                .toEqual(['calculation', 'misread']);
        });

        it('去重、去掉主错因、最多 2 个', () => {
            expect(parseSecondaryCategories('concept, calculation, calculation, misread, method', 'concept'))
                .toEqual(['calculation', 'misread']);
        });

        it('空输入返回空数组', () => {
            expect(parseSecondaryCategories(null, 'concept')).toEqual([]);
        });
    });

    describe('parseQuestionTypeCode', () => {
        it('有效题型原样返回', () => {
            expect(parseQuestionTypeCode('choice')).toBe('choice');
            expect(parseQuestionTypeCode('fill')).toBe('fill');
            expect(parseQuestionTypeCode('judge')).toBe('judge');
        });

        it('无效值归一为 solve', () => {
            expect(parseQuestionTypeCode(null)).toBe('solve');
            expect(parseQuestionTypeCode('essay')).toBe('solve');
        });
    });

    describe('权重与标签', () => {
        it('知识性错因权重 1.5，操作性错因 0.7', () => {
            const byCode = Object.fromEntries(ERROR_CATEGORIES.map((c) => [c.code, c]));
            expect(byCode['concept'].weight).toBe(1.5);
            expect(byCode['method'].weight).toBe(1.5);
            expect(byCode['calculation'].weight).toBe(0.7);
            expect(byCode['careless'].weight).toBe(0.7);
        });

        it('未分类标签兜底', () => {
            expect(getErrorCategoryLabel(null)).toBe('未分类');
            expect(getErrorCategoryLabel('stuck')).toBe('思路卡壳');
        });
    });
});
