/**
 * 知识点薄弱度模型单元测试
 */
import { describe, it, expect } from 'vitest';
import {
    categoryWeight,
    recencyFactor,
    correctnessBoost,
    computeWeaknessReport,
    WeaknessItemInput,
} from '@/lib/weakness';

const NOW = new Date('2026-09-01T12:00:00Z');

function makeItem(overrides: Partial<WeaknessItemInput> = {}): WeaknessItemInput {
    return {
        id: 'item-1',
        errorCategory: 'concept',
        secondaryErrorCategories: null,
        masteryLevel: 0,
        updatedAt: NOW,
        tags: [{ id: 'tag-1', name: '勾股定理' }],
        ...overrides,
    };
}

describe('weakness 薄弱度模型', () => {
    describe('categoryWeight', () => {
        it('主错因取知识性权重 1.5', () => {
            expect(categoryWeight('concept', null)).toBe(1.5);
        });

        it('操作性错因 0.7', () => {
            expect(categoryWeight('careless', null)).toBe(0.7);
        });

        it('次错因按 0.5 比例叠加', () => {
            expect(categoryWeight('concept', JSON.stringify(['calculation']))).toBe(1.5 + 0.7 * 0.5);
        });

        it('未分类默认 1.0', () => {
            expect(categoryWeight(null, null)).toBe(1.0);
        });

        it('非法 JSON 次错因安全忽略', () => {
            expect(categoryWeight('concept', 'not-json')).toBe(1.5);
        });
    });

    describe('recencyFactor', () => {
        it('刚更新的题衰减因子为 1', () => {
            expect(recencyFactor(NOW, NOW)).toBeCloseTo(1.0);
        });

        it('超过半衰期约减半（受 floor 抬升），长期不归零', () => {
            const old = new Date(NOW.getTime() - 30 * 86400000);
            const factor30d = recencyFactor(old, NOW);
            const factor300d = recencyFactor(new Date(NOW.getTime() - 300 * 86400000), NOW);
            expect(factor30d).toBeGreaterThan(0.6);
            expect(factor30d).toBeLessThan(0.9);
            expect(factor300d).toBeCloseTo(0.3, 1); // 贴近下限
        });
    });

    describe('correctnessBoost', () => {
        it('无复习记录 ×1.0', () => {
            expect(correctnessBoost(null)).toBe(1.0);
        });

        it('全错 ×1.2，全对 ×0.6', () => {
            expect(correctnessBoost(0)).toBe(1.2);
            expect(correctnessBoost(1)).toBe(0.6);
        });
    });

    describe('computeWeaknessReport', () => {
        it('按知识点聚合并按薄弱度降序排列', () => {
            const items = [
                makeItem({ id: 'a', errorCategory: 'concept', tags: [{ id: 't1', name: '弱' }] }),
                makeItem({ id: 'b', errorCategory: 'careless', tags: [{ id: 't2', name: '强' }], masteryLevel: 2 }),
            ];
            const report = computeWeaknessReport(items, [], NOW);

            expect(report.ranking).toHaveLength(2);
            expect(report.ranking[0].tagName).toBe('弱'); // concept 1.5 > careless 0.7×0.2
            expect(report.ranking[0].itemCount).toBe(1);
            expect(report.ranking[0].topCategory).toBe('concept');
        });

        it('热力图主错因计 1.0、次错因计 0.5', () => {
            const items = [
                makeItem({
                    id: 'a',
                    errorCategory: 'concept',
                    secondaryErrorCategories: JSON.stringify(['calculation']),
                    tags: [{ id: 't1', name: '勾股定理' }],
                }),
            ];
            const report = computeWeaknessReport(items, [], NOW);
            const catIdx = report.heatmap.categories.findIndex((c) => c.code === 'concept');
            const calcIdx = report.heatmap.categories.findIndex((c) => c.code === 'calculation');
            expect(report.heatmap.cells[0][catIdx]).toBe(1.0);
            expect(report.heatmap.cells[0][calcIdx]).toBe(0.5);
        });

        it('复习正确率调节薄弱度（同条件下全对降权）', () => {
            const items = [makeItem({ id: 'a', tags: [{ id: 't1', name: 'X' }] })];
            const noReview = computeWeaknessReport(items, [], NOW).ranking[0].score;
            const allCorrect = computeWeaknessReport(items, [{ errorItemId: 'a', isCorrect: true }], NOW).ranking[0].score;
            const allWrong = computeWeaknessReport(items, [{ errorItemId: 'a', isCorrect: false }], NOW).ranking[0].score;

            expect(allWrong).toBeGreaterThan(noReview);
            expect(allCorrect).toBeLessThan(noReview);
        });
    });
});
