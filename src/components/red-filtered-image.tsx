"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, MouseEventHandler, MouseEvent as ReactMouseEvent } from "react";
import { Pipette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { filterRedInk, sampleRedInk, inkOptionsSignature, defaultInkOptions, inkOptionsFromSample } from "@/lib/image-color-filter";
import type { InkFilterOptions, PixelBuffer, SampledColor } from "@/lib/image-color-filter";
import type { ImageMask } from "@/lib/image-masks";

/**
 * 去红打印图片：渲染前在浏览器端用 Canvas 滤除红笔痕迹（图片为 base64 同源数据，无跨域限制）。
 *
 * 结果以 dataURL 缓存（模块级 Map，按「图片 + 检测参数」分 key，同图同参数只处理一次），
 * 处理经串行队列逐张排队，避免整卷图片同时解码阻塞主线程。
 * 任何失败都回退原图，绝不阻塞打印流程。
 */

const cache = new Map<string, Promise<string>>();
/** 缓存容量上限：滑杆/取色会按参数组合产生多份结果，超限淘汰最早条目（Map 保持插入序）防内存无限增长 */
const CACHE_LIMIT = 80;

function trimCache() {
    for (const key of cache.keys()) {
        if (cache.size <= CACHE_LIMIT - 20) break;
        cache.delete(key);
    }
}

// 串行队列：解码与像素处理是同步重活，逐张排队避免卡顿
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
}

/** 获取去红后的图片 dataURL（按参数缓存，永不 reject）；打印入口可在 window.print() 前 await 它 */
export function getRedFilteredImage(src: string, options?: InkFilterOptions): Promise<string> {
    const key = `${src}|${inkOptionsSignature(options)}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const p = enqueue(
        () =>
            new Promise<string>((resolve) => {
                const img = new Image();
                img.onload = () => {
                    try {
                        const canvas = document.createElement("canvas");
                        canvas.width = img.naturalWidth;
                        canvas.height = img.naturalHeight;
                        const ctx = canvas.getContext("2d", { willReadFrequently: true });
                        if (!ctx || !canvas.width || !canvas.height) return resolve(src);
                        ctx.drawImage(img, 0, 0);
                        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                        filterRedInk(imageData, options);
                        ctx.putImageData(imageData, 0, 0);
                        resolve(canvas.toDataURL("image/jpeg", 0.85));
                    } catch {
                        resolve(src);
                    }
                };
                img.onerror = () => resolve(src);
                img.src = src;
            })
    );
    cache.set(key, p);
    trimCache();
    return p;
}

/**
 * 从原图取色（取色校准用）：nx/ny 为相对图片的 0~1 归一化坐标。
 * 注意永远对原图采样，与当前显示的去红结果无关。
 */
export function sampleRedInkFromImage(src: string, nx: number, ny: number): Promise<SampledColor | null> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                if (!ctx || !canvas.width || !canvas.height) return resolve(null);
                ctx.drawImage(img, 0, 0);
                const imageData: PixelBuffer = ctx.getImageData(0, 0, canvas.width, canvas.height);
                resolve(sampleRedInk(imageData, Math.round(nx * canvas.width), Math.round(ny * canvas.height)));
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = src;
    });
}

/** 订阅去红结果：enabled=false、参数变化中或处理完成前返回原 src */
export function useRedFilteredSrc(src: string | null, enabled: boolean, options?: InkFilterOptions): string | null {
    // 记录 {src, sig, url} 成对，src 或参数变化后旧结果自动失效
    const sig = inkOptionsSignature(options);
    const [result, setResult] = useState<{ src: string; sig: string; url: string } | null>(null);
    useEffect(() => {
        if (!src || !enabled) return;
        let cancelled = false;
        getRedFilteredImage(src, options).then((url) => {
            if (!cancelled) setResult({ src, sig, url });
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- sig 已含 options 的全部字段
    }, [src, enabled, sig]);
    if (!src || !enabled) return src;
    return result?.src === src && result.sig === sig ? result.url : src;
}

interface RedFilteredImageProps {
    src: string;
    /** false 时直接渲染原图（关闭/豁免过滤；取色校准模式下也应传 false 以显示原图） */
    enabled: boolean;
    /** 取色校准生成的检测参数（多中心数组），缺省用内置默认 */
    options?: InkFilterOptions;
    alt: string;
    className?: string;
    style?: CSSProperties;
    onClick?: MouseEventHandler<HTMLImageElement>;
}

export function RedFilteredImage({ src, enabled, options, alt, className, style, onClick }: RedFilteredImageProps) {
    const displaySrc = useRedFilteredSrc(src, enabled, options);
    return (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={displaySrc ?? src} alt={alt} className={className} style={style} onClick={onClick} />
    );
}

// ── 取色校准状态机（两个打印页共享）──────────────────────────────

/**
 * 多点取色校准：样本累积（每个点击点一个颜色中心）+ 范围档位滑杆 + 取色模式。
 * 页面侧职责只剩布局与文案：图片 onClick 接 pickFrom、按钮/滑杆接返回值。
 * @param failMessage 点击处无显著彩色时的提示文案（各页文案不同，作参数传入）
 */
export function useInkCalibration(failMessage: string) {
    // 多点累积取样（存原始样本色，范围档位变化时按当前档位重新展开）；[] = 围绕正红的默认检测
    const [inkSamples, setInkSamples] = useState<SampledColor[]>([]);
    // 过滤范围档位 0~100（网页滑杆手动调节）：越高容差越宽（滤得越净，但可能误除题目本身的相近色）
    const [rangeLevel, setRangeLevel] = useState(50);
    const [picking, setPicking] = useState(false);

    // 取色模式按 Esc 退出
    useEffect(() => {
        if (!picking) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setPicking(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [picking]);

    const redFilterOptions = useMemo<InkFilterOptions>(
        () =>
            inkSamples.length
                ? inkSamples.map((s) => inkOptionsFromSample(s, rangeLevel))
                : defaultInkOptions(rangeLevel),
        [inkSamples, rangeLevel]
    );

    // 点击原图取样并累积（不自动退出取色模式，连续多点覆盖深浅）；永远对原图采样
    const pickFrom = useCallback(
        async (e: ReactMouseEvent<HTMLImageElement>, src: string) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const sample = await sampleRedInkFromImage(
                src,
                (e.clientX - rect.left) / rect.width,
                (e.clientY - rect.top) / rect.height
            );
            if (!sample) {
                alert(failMessage);
                return;
            }
            setInkSamples((list) => [...list, sample]);
        },
        [failMessage]
    );

    /** 恢复默认：清空取样并重置档位 */
    const reset = useCallback(() => {
        setInkSamples([]);
        setRangeLevel(50);
    }, []);

    return { inkSamples, rangeLevel, setRangeLevel, picking, setPicking, redFilterOptions, pickFrom, reset };
}

/**
 * 取色校准工具条（取色按钮 + 恢复默认 + 过滤范围滑杆），三个打印页共用，
 * 文案统一走 t.inkCalibration。布局上放在工具栏 flex 容器里，三件套之间自排。
 */
export function InkCalibrationControls({
    calibration,
    size = "sm",
}: {
    calibration: ReturnType<typeof useInkCalibration>;
    size?: "sm" | "default";
}) {
    const { t } = useLanguage();
    const { inkSamples, rangeLevel, setRangeLevel, picking, setPicking, reset } = calibration;
    // 拖动防抖：本地即时回显，停止拖动 ~250ms 后才提交档位（避免每个中间档都触发全卷重滤）
    const [localLevel, setLocalLevel] = useState(rangeLevel);
    const [lastSynced, setLastSynced] = useState(rangeLevel);
    if (rangeLevel !== lastSynced) {
        // 外部（reset）变化时回写本地——渲染期对齐，立即重渲染丢弃本次输出
        setLastSynced(rangeLevel);
        setLocalLevel(rangeLevel);
    }
    useEffect(() => {
        if (localLevel === rangeLevel) return;
        const timer = setTimeout(() => setRangeLevel(localLevel), 250);
        return () => clearTimeout(timer);
    }, [localLevel, rangeLevel, setRangeLevel]);
    return (
        <>
            <Button
                type="button"
                variant="outline"
                size={size}
                onClick={() => setPicking((p) => !p)}
                title={t.inkCalibration?.pickHint || "点击原图中的红笔痕迹取样（当前显示未过滤原图），可连续点击多个位置覆盖深浅；按 Esc 结束"}
            >
                <Pipette className={size === "default" ? "mr-2 h-4 w-4" : "h-3.5 w-3.5"} />
                {picking
                    ? t.inkCalibration?.pickActive || "多点取色中…（Esc 结束）"
                    : inkSamples.length > 0
                        ? (t.inkCalibration?.pickDone || "取色校准（{n} 处）").replace("{n}", String(inkSamples.length))
                        : t.inkCalibration?.pick || "取色校准"}
            </Button>
            {inkSamples.length > 0 && !picking && (
                <Button type="button" variant="ghost" size="sm" className="px-2 text-xs" onClick={reset}>
                    {t.inkCalibration?.reset || "恢复默认"}
                </Button>
            )}
            <label
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
                title={t.inkCalibration?.rangeHint || "调节颜色匹配宽容度：调大滤得更净，但可能误除题目本身的相近色"}
            >
                <span className="whitespace-nowrap">{t.inkCalibration?.range || "过滤范围"}</span>
                <input
                    type="range"
                    min="0"
                    max="100"
                    step="10"
                    value={localLevel}
                    onChange={(e) => setLocalLevel(Number(e.target.value))}
                    className="w-20 accent-primary cursor-pointer"
                />
            </label>
        </>
    );
}

// ── 带遮罩的原题图（试卷页/复习卷打印页共用）─────────────────────────

interface MaskedOriginalImageProps {
    src: string;
    /** 打印遮罩（白块覆盖手写痕迹），0-1 归一化坐标 */
    masks: ImageMask[];
    /** 红笔过滤是否生效（取色模式下应传 false 以显示原图） */
    redFilterEnabled: boolean;
    options?: InkFilterOptions;
    /** 取色模式：图片可点击取样 */
    picking: boolean;
    onPick?: (e: ReactMouseEvent<HTMLImageElement>, src: string) => void;
    /** 图片尺寸类（如 max-w 百分比） */
    className?: string;
    /** 透传给图片的内联样式（如 maxWidth 比例调节） */
    style?: CSSProperties;
}

/**
 * 原题图 + 去红 + 手写遮罩白块的组合（含取色接线）。
 * 打印遮罩必须带 print-color-adjust: exact，否则打印时白块透明失效——集中在此单一实现。
 */
export function MaskedOriginalImage({ src, masks, redFilterEnabled, options, picking, onPick, className, style }: MaskedOriginalImageProps) {
    return (
        <div className="relative inline-block">
            <RedFilteredImage
                src={src}
                enabled={redFilterEnabled && !picking}
                options={options}
                alt="原题"
                className={`block rounded border ${className ?? ""} ${picking ? "cursor-crosshair" : ""}`}
                style={style}
                onClick={picking && onPick ? (e) => onPick(e, src) : undefined}
            />
            {masks?.map((m, i) => (
                <div
                    key={i}
                    className="absolute bg-white print:border-0"
                    style={{
                        left: `${m.x * 100}%`,
                        top: `${m.y * 100}%`,
                        width: `${m.w * 100}%`,
                        height: `${m.h * 100}%`,
                        printColorAdjust: "exact",
                        WebkitPrintColorAdjust: "exact",
                    }}
                />
            ))}
        </div>
    );
}
