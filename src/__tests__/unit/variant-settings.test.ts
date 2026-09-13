/**
 * 变式自动生成配置解析单元测试
 */
import { describe, it, expect } from 'vitest';
import { parseVariantSettings, serializeVariantSettings, totalVariantCount, DEFAULT_VARIANT_SETTINGS } from '@/lib/variant-settings';

describe('parseVariantSettings', () => {
    it('null/损坏 JSON 应回退默认（默认关闭）', () => {
        expect(parseVariantSettings(null)).toEqual(DEFAULT_VARIANT_SETTINGS);
        expect(parseVariantSettings('not json')).toEqual(DEFAULT_VARIANT_SETTINGS);
        expect(parseVariantSettings(123)).toEqual(DEFAULT_VARIANT_SETTINGS);
        expect(DEFAULT_VARIANT_SETTINGS.enabled).toBe(false);
    });

    it('应接受合法配置', () => {
        const s = parseVariantSettings({ enabled: true, perDifficulty: { easy: 1, medium: 2, hard: 3, harder: 1 } });
        expect(s.enabled).toBe(true);
        expect(s.perDifficulty).toEqual({ easy: 1, medium: 2, hard: 3, harder: 1 });
    });

    it('应丢弃非法数量（非整数、越界、非数字）并保留合法项', () => {
        const s = parseVariantSettings({ enabled: true, perDifficulty: { easy: -1, medium: 2.5, hard: 6, harder: 2 } });
        expect(s.perDifficulty.easy).toBe(0);      // 默认 0
        expect(s.perDifficulty.medium).toBe(1);    // 默认 1
        expect(s.perDifficulty.hard).toBe(2);      // 默认 2
        expect(s.perDifficulty.harder).toBe(2);    // 合法保留
    });

    it('序列化-解析回环应无损', () => {
        const s = { enabled: true, perDifficulty: { easy: 0, medium: 1, hard: 3, harder: 2 } };
        expect(parseVariantSettings(serializeVariantSettings(s))).toEqual(s);
    });

    it('totalVariantCount 应汇总各难度数量', () => {
        expect(totalVariantCount(DEFAULT_VARIANT_SETTINGS)).toBe(4); // 0+1+2+1
        expect(totalVariantCount({ enabled: false, perDifficulty: { easy: 0, medium: 0, hard: 0, harder: 0 } })).toBe(0);
    });
});
