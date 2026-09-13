/**
 * 复习设置解析单元测试
 * 覆盖：缺省/损坏回退、dailyLimit 边界、errorCategories 无效 code 过滤与空数组归一
 */
import { describe, it, expect } from 'vitest';
import { parseReviewSettings, serializeReviewSettings, isSameReviewSettings, DEFAULT_REVIEW_SETTINGS } from '@/lib/review-settings';

describe('parseReviewSettings', () => {
    it('null/undefined/损坏 JSON 应回退默认值', () => {
        expect(parseReviewSettings(null)).toEqual(DEFAULT_REVIEW_SETTINGS);
        expect(parseReviewSettings(undefined)).toEqual(DEFAULT_REVIEW_SETTINGS);
        expect(parseReviewSettings('not json')).toEqual(DEFAULT_REVIEW_SETTINGS);
    });

    it('应接受合法的 dailyLimit', () => {
        expect(parseReviewSettings('{"dailyLimit":20}').dailyLimit).toBe(20);
        expect(parseReviewSettings('{"dailyLimit":1}').dailyLimit).toBe(1);
        expect(parseReviewSettings('{"dailyLimit":200}').dailyLimit).toBe(200);
    });

    it('应拒绝非法的 dailyLimit（非整数、越界、非数字）', () => {
        expect(parseReviewSettings('{"dailyLimit":0}').dailyLimit).toBeNull();
        expect(parseReviewSettings('{"dailyLimit":-5}').dailyLimit).toBeNull();
        expect(parseReviewSettings('{"dailyLimit":201}').dailyLimit).toBeNull();
        expect(parseReviewSettings('{"dailyLimit":10.5}').dailyLimit).toBeNull();
        expect(parseReviewSettings('{"dailyLimit":"20"}').dailyLimit).toBeNull();
    });

    it('应过滤无效的错因 code，空数组归一为 null（不过滤）', () => {
        expect(parseReviewSettings('{"errorCategories":["stuck","concept"]}').errorCategories).toEqual(['stuck', 'concept']);
        expect(parseReviewSettings('{"errorCategories":["stuck","invalid_code","x"]}').errorCategories).toEqual(['stuck']);
        expect(parseReviewSettings('{"errorCategories":[]}').errorCategories).toBeNull();
        expect(parseReviewSettings('{"errorCategories":"stuck"}').errorCategories).toBeNull();
    });

    it('序列化-解析回环应无损', () => {
        const s = { dailyLimit: 15, errorCategories: ['concept', 'stuck'] };
        expect(parseReviewSettings(serializeReviewSettings(s))).toEqual(s);
    });
});

describe('isSameReviewSettings', () => {
    it('应比较两个设置是否等价', () => {
        expect(isSameReviewSettings({ dailyLimit: 10, errorCategories: null }, { dailyLimit: 10, errorCategories: [] })).toBe(true);
        expect(isSameReviewSettings({ dailyLimit: 10, errorCategories: ['a'] }, { dailyLimit: 10, errorCategories: ['a', 'b'] })).toBe(false);
        expect(isSameReviewSettings({ dailyLimit: null, errorCategories: null }, { dailyLimit: 5, errorCategories: null })).toBe(false);
    });
});
