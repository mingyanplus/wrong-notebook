/**
 * 组卷出题计划单元测试
 * 核心语义：count = 试卷目标题数；池不足时循环错题池用变式补齐（单题有上限）
 */
import { describe, it, expect } from 'vitest';
import { buildPaperPlan } from '@/lib/paper-plan';

interface Item { id: string }
const pool = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ id: `i${i}` }));
const getId = (x: Item) => x.id;

describe('buildPaperPlan', () => {
    it('纯原题：池充足时恰好取目标题数', () => {
        const plan = buildPaperPlan(pool(10), 'original', 6, 0.5, 3, getId);
        expect(plan).toHaveLength(6);
        expect(plan.every((p) => !p.isVariant)).toBe(true);
    });

    it('纯原题：池不足时只能少于目标（不虚构题目）', () => {
        const plan = buildPaperPlan(pool(4), 'original', 10, 0.5, 3, getId);
        expect(plan).toHaveLength(4);
    });

    it('混合：按比例分配且总数 = 目标题数', () => {
        const plan = buildPaperPlan(pool(10), 'mixed', 10, 0.5, 3, getId);
        expect(plan).toHaveLength(10);
        expect(plan.filter((p) => p.isVariant)).toHaveLength(5);
        expect(plan.filter((p) => !p.isVariant)).toHaveLength(5);
    });

    it('混合：池不足时循环池用变式补齐到目标题数', () => {
        // 池 4 题、目标 10、比例 0.5 → 原题 min(4, round(10×0.5))=4 道 + 变式 6 道（池轮询补齐、单题上限 3）
        const plan = buildPaperPlan(pool(4), 'mixed', 10, 0.5, 3, getId);
        expect(plan).toHaveLength(10);
        expect(plan.filter((p) => p.isVariant)).toHaveLength(6);
        expect(plan.filter((p) => !p.isVariant)).toHaveLength(4);
        const perItem = new Map<string, number>();
        plan.filter((p) => p.isVariant).forEach((p) => perItem.set(p.item.id, (perItem.get(p.item.id) ?? 0) + 1));
        perItem.forEach((v) => expect(v).toBeLessThanOrEqual(3));
    });

    it('纯变式：池充足时每题一道变式', () => {
        const plan = buildPaperPlan(pool(10), 'variant', 6, 0.5, 3, getId);
        expect(plan).toHaveLength(6);
        expect(plan.every((p) => p.isVariant)).toBe(true);
        expect(new Set(plan.map((p) => p.item.id)).size).toBe(6);
    });

    it('纯变式：池不足时同题多道变式补齐，但不超过单题上限', () => {
        // 池 2 题、目标 6、上限 3 → 每题 3 道
        const plan = buildPaperPlan(pool(2), 'variant', 6, 0.5, 3, getId);
        expect(plan).toHaveLength(6);
        const counts = new Map<string, number>();
        plan.forEach((p) => counts.set(p.item.id, (counts.get(p.item.id) ?? 0) + 1));
        counts.forEach((v) => expect(v).toBe(3));
    });

    it('上限约束下确实凑不够时，安全返回（不死循环）', () => {
        // 池 2 题、上限 1、目标 5 → 纯变式最多 2 道
        const plan = buildPaperPlan(pool(2), 'variant', 5, 0.5, 1, getId);
        expect(plan).toHaveLength(2);
    });

    it('空池返回空计划', () => {
        expect(buildPaperPlan([], 'mixed', 10, 0.5, 3, getId)).toEqual([]);
    });
});
