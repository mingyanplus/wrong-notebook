/**
 * 艾宾浩斯复习调度器单元测试
 */
import { describe, it, expect } from 'vitest';
import { getReviewIntervalDays, calculateNextReviewDate } from '@/lib/scheduler';

describe('scheduler 艾宾浩斯调度', () => {
    describe('getReviewIntervalDays', () => {
        it('基础阶段应返回 1/2/4/7/15/30 天', () => {
            expect(getReviewIntervalDays(0)).toBe(1);
            expect(getReviewIntervalDays(1)).toBe(2);
            expect(getReviewIntervalDays(2)).toBe(4);
            expect(getReviewIntervalDays(3)).toBe(7);
            expect(getReviewIntervalDays(4)).toBe(15);
            expect(getReviewIntervalDays(5)).toBe(30);
        });

        it('扩展阶段应按 1.5 倍递增（45 → 68）', () => {
            expect(getReviewIntervalDays(6)).toBe(45);
            expect(getReviewIntervalDays(7)).toBe(68); // 30 × 1.5² = 67.5 → 68
        });

        it('间隔最长不超过 90 天', () => {
            expect(getReviewIntervalDays(8)).toBe(90);
            expect(getReviewIntervalDays(20)).toBe(90);
        });
    });

    describe('calculateNextReviewDate', () => {
        it('应基于当前时间加上对应间隔', () => {
            const before = Date.now();
            const date = calculateNextReviewDate(0).getTime();
            const after = Date.now();
            expect(date).toBeGreaterThanOrEqual(before + 1 * 86400000 - 1000);
            expect(date).toBeLessThanOrEqual(after + 1 * 86400000 + 1000);
        });
    });


});
