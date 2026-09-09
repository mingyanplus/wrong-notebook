/**
 * 原题图片打印遮罩：归一化矩形（0-1 相对坐标），打印时白块覆盖原图上的手写/批改痕迹。
 * 坐标必须按比例存储（屏幕 45% 宽、打印 55% 宽渲染时都能精确对位），严禁存像素。
 */
export interface ImageMask {
    x: number; // 左上角 X（相对图片宽度 0-1）
    y: number; // 左上角 Y（相对图片高度 0-1）
    w: number; // 宽（相对图片宽度 0-1）
    h: number; // 高（相对图片高度 0-1）
}

const MAX_MASKS = 30;

function isValidMask(m: unknown): m is ImageMask {
    if (typeof m !== "object" || m === null) return false;
    const { x, y, w, h } = m as Record<string, unknown>;
    return (
        typeof x === "number" && typeof y === "number" && typeof w === "number" && typeof h === "number" &&
        Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h) &&
        x >= 0 && x <= 1 && y >= 0 && y <= 1 && w >= 0 && w <= 1 && h >= 0 && h <= 1 &&
        w > 0 && h > 0
    );
}

/** 解析数据库中的遮罩 JSON，容忍坏数据（解析失败/格式非法返回空数组） */
export function parseImageMasks(raw: string | null | undefined): ImageMask[] {
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidMask);
}

/** 校验并序列化为存储 JSON；空数组返回 null（清除遮罩） */
export function serializeImageMasks(input: unknown): string | null {
    if (!Array.isArray(input)) return null;
    const masks = input.filter(isValidMask).slice(0, MAX_MASKS);
    return masks.length > 0 ? JSON.stringify(masks) : null;
}
