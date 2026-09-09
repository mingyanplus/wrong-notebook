/**
 * 打印遮罩（image-masks）单元测试：归一化校验、序列化、坏数据容错
 */
import { describe, it, expect } from 'vitest';
import { parseImageMasks, serializeImageMasks } from '@/lib/image-masks';

describe('parseImageMasks', () => {
    it('空输入返回空数组', () => {
        expect(parseImageMasks(null)).toEqual([]);
        expect(parseImageMasks(undefined)).toEqual([]);
        expect(parseImageMasks('')).toEqual([]);
    });

    it('合法 JSON 数组正确解析', () => {
        const raw = JSON.stringify([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }]);
        expect(parseImageMasks(raw)).toEqual([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }]);
    });

    it('非法 JSON 返回空数组', () => {
        expect(parseImageMasks('not-json')).toEqual([]);
    });

    it('过滤格式非法的条目（坐标越界/缺字段/零尺寸）', () => {
        const raw = JSON.stringify([
            { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },            // 合法
            { x: -0.1, y: 0, w: 0.2, h: 0.2 },             // x 越界
            { x: 1.5, y: 0, w: 0.2, h: 0.2 },              // x 超过 1
            { x: 0.1, y: 0.1, w: 0, h: 0.2 },              // 零宽
            { x: 0.1, y: 0.1, w: 0.2 },                    // 缺 h
            { x: '0.1', y: 0.1, w: 0.2, h: 0.2 },          // 类型错误
            null,                                             // 非对象
        ]);
        expect(parseImageMasks(raw)).toEqual([{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }]);
    });

    it('非数组 JSON 返回空数组', () => {
        expect(parseImageMasks('{"x":1}')).toEqual([]);
    });
});

describe('serializeImageMasks', () => {
    it('合法遮罩序列化为 JSON 字符串', () => {
        const out = serializeImageMasks([{ x: 0, y: 0, w: 0.5, h: 0.5 }]);
        expect(out).toBe(JSON.stringify([{ x: 0, y: 0, w: 0.5, h: 0.5 }]));
    });

    it('空数组清除遮罩（返回 null）', () => {
        expect(serializeImageMasks([])).toBeNull();
    });

    it('非数组输入返回 null', () => {
        expect(serializeImageMasks(undefined)).toBeNull();
        expect(serializeImageMasks('bad')).toBeNull();
    });

    it('过滤非法条目后序列化', () => {
        const out = serializeImageMasks([
            { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
            { x: 2, y: 0, w: 0.1, h: 0.1 }, // 非法被过滤
        ]);
        expect(out).toBe(JSON.stringify([{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }]));
    });

    it('全部非法时返回 null', () => {
        expect(serializeImageMasks([{ x: -1, y: 0, w: 0.1, h: 0.1 }])).toBeNull();
    });
});
