/**
 * 红笔痕迹过滤单元测试
 * 覆盖：单像素红色强度判定（红笔深浅、误杀场景排除）、整图像素处理、取色校准
 */
import { describe, it, expect } from 'vitest';
import { redInkStrength, filterRedInk, sampleRedInk, redInkOptionsFromSample } from '@/lib/image-color-filter';
import type { PixelBuffer, SampledColor } from '@/lib/image-color-filter';

/** 构造单行 RGBA 像素缓冲 */
function makeBuffer(pixels: Array<[number, number, number, number?]>): PixelBuffer {
    const data = new Uint8ClampedArray(pixels.length * 4);
    pixels.forEach(([r, g, b, a = 255], i) => {
        data[i * 4] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = a;
    });
    return { data, width: pixels.length, height: 1 };
}

/** 构造纯色二维像素缓冲 */
function makeGrid(width: number, height: number, fill: [number, number, number]): PixelBuffer {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = fill[0];
        data[i * 4 + 1] = fill[1];
        data[i * 4 + 2] = fill[2];
        data[i * 4 + 3] = 255;
    }
    return { data, width, height };
}

function setPixel(buffer: PixelBuffer, x: number, y: number, rgb: [number, number, number]) {
    const i = (y * buffer.width + x) * 4;
    buffer.data[i] = rgb[0];
    buffer.data[i + 1] = rgb[1];
    buffer.data[i + 2] = rgb[2];
}

describe('redInkStrength (单像素红色判定)', () => {
    it('应该识别各种深浅的红笔墨水', () => {
        expect(redInkStrength(180, 40, 40)).toBeGreaterThanOrEqual(0.9);   // 典型红笔
        expect(redInkStrength(120, 30, 30)).toBeGreaterThanOrEqual(0.9);   // 深红
        expect(redInkStrength(220, 110, 90)).toBeGreaterThanOrEqual(0.7);  // 暖光下偏橙的红笔
        expect(redInkStrength(200, 60, 100)).toBeGreaterThanOrEqual(0.5);  // 偏品红的红笔
    });

    it('不应该误杀印刷与纸面像素', () => {
        expect(redInkStrength(0, 0, 0)).toBe(0);            // 黑色印刷
        expect(redInkStrength(255, 255, 255)).toBe(0);      // 白纸
        expect(redInkStrength(128, 128, 128)).toBe(0);      // 铅笔灰
        expect(redInkStrength(40, 90, 180)).toBe(0);        // 蓝色钢笔
        expect(redInkStrength(30, 140, 60)).toBe(0);        // 绿色
        expect(redInkStrength(230, 220, 200)).toBe(0);      // 米色纸面
        expect(redInkStrength(180, 170, 160)).toBe(0);      // 纸面阴影（低饱和暖色）
    });

    it('暗红色应保守保留（与黑字无法区分）', () => {
        expect(redInkStrength(50, 20, 20)).toBe(0);         // 亮度低于下限
    });

    it('边缘淡红像素应产生中间强度（平滑过渡）', () => {
        const s = redInkStrength(230, 150, 150);            // 红与白混合的抗锯齿像素
        expect(s).toBeGreaterThan(0);
        expect(s).toBeLessThan(0.5);
    });
});

describe('filterRedInk (整图像素处理)', () => {
    it('应该把红色像素替换为白色，其他颜色保持不变', () => {
        const buffer = makeBuffer([
            [180, 40, 40],   // 红笔
            [10, 10, 10],    // 黑字
            [40, 90, 180],   // 蓝笔
            [255, 255, 255], // 白纸
        ]);
        filterRedInk(buffer);
        const d = buffer.data;
        // 红笔像素 → 白
        expect(d[0]).toBeGreaterThanOrEqual(250);
        expect(d[1]).toBeGreaterThanOrEqual(250);
        expect(d[2]).toBeGreaterThanOrEqual(250);
        // 黑/蓝/白像素不变
        expect([d[4], d[5], d[6]]).toEqual([10, 10, 10]);
        expect([d[8], d[9], d[10]]).toEqual([40, 90, 180]);
        expect([d[12], d[13], d[14]]).toEqual([255, 255, 255]);
    });

    it('不应该改动 alpha 通道', () => {
        const buffer = makeBuffer([[180, 40, 40, 200], [0, 0, 0, 128]]);
        filterRedInk(buffer);
        expect(buffer.data[3]).toBe(200);
        expect(buffer.data[7]).toBe(128);
    });
});

describe('sampleRedInk (取色采样)', () => {
    it('应该取 5×5 邻域内饱和度最高的像素作为样本', () => {
        const buffer = makeGrid(5, 5, [255, 255, 255]); // 白纸
        setPixel(buffer, 1, 2, [180, 40, 40]);          // 邻域内一笔红
        setPixel(buffer, 3, 3, [120, 110, 105]);        // 邻域内低饱和阴影
        const sample = sampleRedInk(buffer, 2, 2);
        expect(sample).not.toBeNull();
        expect([sample!.r, sample!.g, sample!.b]).toEqual([180, 40, 40]);
    });

    it('全白邻域应返回 null（无显著彩色）', () => {
        const buffer = makeGrid(5, 5, [250, 248, 245]);
        expect(sampleRedInk(buffer, 2, 2)).toBeNull();
    });

    it('点击位置在边界外应钳制坐标而不越界', () => {
        const buffer = makeGrid(5, 5, [255, 255, 255]);
        setPixel(buffer, 4, 4, [180, 40, 40]);
        const sample = sampleRedInk(buffer, 10, 10); // 越界点击钳制到 (4,4) 邻域
        expect(sample).not.toBeNull();
        expect(sample!.r).toBe(180);
    });
});

describe('redInkOptionsFromSample (样本生成检测参数)', () => {
    const sample: SampledColor = { r: 200, g: 90, b: 90, h: 8, s: 0.75, v: 0.7 };

    it('应该以样本色相为中心并放宽饱和度/亮度下限', () => {
        const opts = redInkOptionsFromSample(sample);
        expect(opts.hueCenter).toBe(8);
        expect(opts.maxHueDistance).toBe(15);
        expect(opts.minSaturation).toBe(0.55); // 0.75 - 0.2
        expect(opts.minBrightness).toBe(0.5);  // 0.7 - 0.2
    });

    it('放宽后的下限不应低于 0.15（防误杀纸面）', () => {
        const pale: SampledColor = { ...sample, s: 0.3, v: 0.28 };
        const opts = redInkOptionsFromSample(pale);
        expect(opts.minSaturation).toBe(0.15);
        expect(opts.minBrightness).toBe(0.15);
    });
});

describe('redInkStrength (校准后的任意中心色)', () => {
    it('应该围绕校准中心色检测（如校准到蓝笔）', () => {
        const opts = { hueCenter: 210 };
        expect(redInkStrength(40, 90, 180, opts)).toBeGreaterThan(0.7); // 蓝笔命中
        expect(redInkStrength(180, 40, 40, opts)).toBe(0);              // 正红不再命中
    });

    it('校准到偏色红笔后正红仍应部分命中', () => {
        const opts = { hueCenter: 12, maxHueDistance: 15 }; // 取样到偏橙红笔
        expect(redInkStrength(220, 110, 90, opts)).toBeGreaterThan(0.9); // 样本同色
        expect(redInkStrength(180, 40, 40, opts)).toBeGreaterThan(0.3);  // 正红距 12° 仍在范围内
    });
});
