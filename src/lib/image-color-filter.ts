/**
 * 红笔痕迹过滤：打印错题原图时去除红笔订正/批改痕迹，防止泄露答案。
 *
 * 原理：红墨水在 HSV 空间的特征是色相约 0°（环形跨 0°，含少量偏橙/偏品红）、
 * 饱和度与亮度显著高于灰白纸面，与黑色印刷、灰色铅笔、蓝色钢笔均可区分。
 * 判定为红的像素按"红色强度"向白色线性混合（而非硬阈值二值化），
 * 使红字边缘的抗锯齿像素平滑过渡，不留淡色描边。
 */

export interface PixelBuffer {
    /** RGBA 顺序像素数据，长度 = width * height * 4，结构与 ImageData 兼容 */
    data: Uint8ClampedArray | Uint8Array;
    width: number;
    height: number;
}

export interface RedInkFilterOptions {
    /** 检测目标色的中心色相（度，环形），默认 0=正红；取色校准后为取样色的色相 */
    hueCenter?: number;
    /** 距中心色相的最大距离（度），超过则不算目标色 */
    maxHueDistance?: number;
    /** 低于该饱和度视为纸面/灰白，不过滤（排除整体偏色的纸张） */
    minSaturation?: number;
    /** 低于该亮度视为暗色墨迹，保守不过滤（与黑色字迹无法区分） */
    minBrightness?: number;
}

const DEFAULT_OPTIONS = {
    hueCenter: 0,
    maxHueDistance: 25,
    minSaturation: 0.3,
    minBrightness: 0.2,
} as const;

/** 平滑阶梯：x <= edge0 → 0，x >= edge1 → 1，中间平滑过渡 */
function smoothstep(edge0: number, edge1: number, x: number): number {
    if (x <= edge0) return 0;
    if (x >= edge1) return 1;
    const t = (x - edge0) / (edge1 - edge0);
    return t * t * (3 - 2 * t);
}

/** 两色相的环形距离（0~180） */
function hueDistance(h1: number, h2: number): number {
    const d = Math.abs(h1 - h2) % 360;
    return d > 180 ? 360 - d : d;
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return [h, max === 0 ? 0 : d / max, max / 255];
}

/**
 * 单像素目标色墨水强度（0 = 保留原样，1 = 完全替换为白色）。
 * 色相/饱和度/亮度三维度各算一个 0~1 得分，取最小值（短板决定强度）。
 */
export function redInkStrength(r: number, g: number, b: number, options?: RedInkFilterOptions): number {
    const o = { ...DEFAULT_OPTIONS, ...options };
    const [h, s, v] = rgbToHsv(r, g, b);
    const hueScore = 1 - smoothstep(o.maxHueDistance * 0.6, o.maxHueDistance, hueDistance(h, o.hueCenter));
    const satScore = smoothstep(o.minSaturation, o.minSaturation + 0.15, s);
    const valScore = smoothstep(o.minBrightness, o.minBrightness + 0.15, v);
    return Math.min(hueScore, satScore, valScore);
}

/** 原地过滤像素缓冲中的红色墨水（向白色按强度混合，alpha 通道不动） */
export function filterRedInk(buffer: PixelBuffer, options?: RedInkFilterOptions): void {
    const d = buffer.data;
    for (let i = 0; i < d.length; i += 4) {
        const strength = redInkStrength(d[i], d[i + 1], d[i + 2], options);
        if (strength > 0) {
            d[i] += (255 - d[i]) * strength;
            d[i + 1] += (255 - d[i + 1]) * strength;
            d[i + 2] += (255 - d[i + 2]) * strength;
        }
    }
}

/** 取色样本：一个像素的 RGB 与 HSV 表示 */
export interface SampledColor {
    r: number;
    g: number;
    b: number;
    h: number;
    s: number;
    v: number;
}

/**
 * 取点击处 5×5 邻域内"饱和度×亮度"得分最高的像素作为墨水样本
 * （点到笔迹边缘或白纸时不会把范围带偏）。邻域内无显著彩色时返回 null。
 */
export function sampleRedInk(buffer: PixelBuffer, x: number, y: number): SampledColor | null {
    const { data, width, height } = buffer;
    let best: SampledColor | null = null;
    let bestScore = -1;
    for (let dy = -2; dy <= 2; dy++) {
        const py = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -2; dx <= 2; dx++) {
            const px = Math.min(width - 1, Math.max(0, x + dx));
            const i = (py * width + px) * 4;
            const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
            const [h, s, v] = rgbToHsv(r, g, b);
            // 亮度封顶 0.8：避免高亮的低饱和白纸像素胜出
            const score = s * Math.min(v, 0.8);
            if (score > bestScore) {
                bestScore = score;
                best = { r, g, b, h, s, v };
            }
        }
    }
    return best && best.s >= 0.2 && best.v >= 0.15 ? best : null;
}

/**
 * 由取样色生成检测参数：以样本色相为中心 ±15°，
 * 饱和度/亮度在样本基础上放宽 0.2（覆盖笔画粗细带来的深浅差异），下限 0.15 防误杀纸面。
 */
export function redInkOptionsFromSample(sample: SampledColor): Required<RedInkFilterOptions> {
    const round2 = (n: number) => Math.round(n * 100) / 100;
    return {
        hueCenter: Math.round(sample.h),
        maxHueDistance: 15,
        minSaturation: Math.max(0.15, round2(sample.s - 0.2)),
        minBrightness: Math.max(0.15, round2(sample.v - 0.2)),
    };
}
