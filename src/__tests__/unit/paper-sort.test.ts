/**
 * 试卷题目排序单元测试
 * 覆盖：默认保序、知识点/错因分组排序、随机洗牌的确定性与组结构保持
 */
import { describe, it, expect } from 'vitest';
import { sortPaperQuestions, mulberry32 } from '@/lib/paper-sort';
import type { SortablePaperQuestion } from '@/lib/paper-sort';

let seq = 0;
function q(section: string, partial: Partial<SortablePaperQuestion> = {}): SortablePaperQuestion & { name: string } {
    return {
        id: `q${++seq}`,
        name: `q${seq}`,
        order: seq,
        section,
        knowledgePoints: null,
        errorCategory: null,
        ...partial,
    };
}

/** 摊平 Map 顺序输出各题 name，便于断言 */
function flatNames(result: Map<string, Array<SortablePaperQuestion & { name: string }>>): string[] {
    return Array.from(result.values()).flat().map((x) => x.name);
}

describe('sortPaperQuestions', () => {
    it('默认模式应保持组卷顺序且大题结构不变', () => {
        seq = 0;
        const items = [q('choice'), q('choice'), q('fill'), q('choice'), q('solve')];
        const result = sortPaperQuestions(items, 'default', 1);
        expect(Array.from(result.keys())).toEqual(['choice', 'fill', 'solve']);
        expect(flatNames(result)).toEqual(['q1', 'q2', 'q4', 'q3', 'q5']);
    });

    it('按知识点排序应让同知识点相邻，无知识点排最后', () => {
        seq = 0;
        const items = [
            q('choice', { knowledgePoints: '["勾股定理"]' }),
            q('choice', { knowledgePoints: '["相似三角形"]' }),
            q('choice', { knowledgePoints: '["勾股定理"]' }),
            q('choice', { knowledgePoints: null }),
        ];
        const result = sortPaperQuestions(items, 'knowledge', 1);
        const names = flatNames(result);
        expect(names[0]).not.toBe('q4'); // 无知识点的题不在最前
        expect(names.indexOf('q1') < names.indexOf('q3')).toBe(true); // 同知识点相邻（勾股定理两题先后出现）
        expect(names[3]).toBe('q4'); // 无知识点排最后
    });

    it('按错因排序应按错因体系顺序，无错因排最后', () => {
        seq = 0;
        const items = [
            q('choice', { errorCategory: 'calculation' }), // 计算失误，体系第 3
            q('choice', { errorCategory: 'concept' }),     // 概念不清，体系第 1
            q('choice', { errorCategory: null }),
            q('choice', { errorCategory: 'stuck' }),       // 思路卡壳，体系第 6
        ];
        const result = sortPaperQuestions(items, 'error', 1);
        expect(flatNames(result)).toEqual(['q2', 'q1', 'q4', 'q3']);
    });

    it('随机洗牌：同 seed 结果确定，不同 seed 结果可复现地不同，组结构保持', () => {
        seq = 0;
        const items = Array.from({ length: 8 }, () => q('choice'));
        const a1 = flatNames(sortPaperQuestions(items, 'shuffle', 42));
        const a2 = flatNames(sortPaperQuestions(items, 'shuffle', 42));
        const b = flatNames(sortPaperQuestions(items, 'shuffle', 43));
        expect(a1).toEqual(a2);  // 同 seed 确定性
        expect(a1.slice().sort()).toEqual(b.slice().sort()); // 元素不变
        expect(Array.from(sortPaperQuestions(items, 'shuffle', 42).keys())).toEqual(['choice']); // 组结构保持
    });

    it('洗牌只在大题内部进行，组间顺序保持题型顺序', () => {
        seq = 0;
        const items = [q('solve'), q('choice'), q('fill'), q('choice'), q('solve')];
        const result = sortPaperQuestions(items, 'shuffle', 7);
        expect(Array.from(result.keys())).toEqual(['solve', 'choice', 'fill']); // 首现顺序
        expect(result.get('choice')?.length).toBe(2);
    });
});

describe('mulberry32', () => {
    it('同 seed 序列相同，输出在 [0,1)', () => {
        const a = mulberry32(123);
        const b = mulberry32(123);
        for (let i = 0; i < 10; i++) {
            const va = a();
            expect(va).toBe(b());
            expect(va).toBeGreaterThanOrEqual(0);
            expect(va).toBeLessThan(1);
        }
    });
});
