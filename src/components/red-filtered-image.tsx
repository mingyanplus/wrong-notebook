"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, MouseEventHandler } from "react";
import { filterRedInk, sampleRedInk } from "@/lib/image-color-filter";
import type { PixelBuffer, RedInkFilterOptions, SampledColor } from "@/lib/image-color-filter";

/**
 * 去红打印图片：渲染前在浏览器端用 Canvas 滤除红笔痕迹（图片为 base64 同源数据，无跨域限制）。
 *
 * 结果以 dataURL 缓存（模块级 Map，按「图片 + 检测参数」分 key，同图同参数只处理一次），
 * 处理经串行队列逐张排队，避免整卷图片同时解码阻塞主线程。
 * 任何失败都回退原图，绝不阻塞打印流程。
 */

/** 参数签名（与 lib 默认值保持一致），用于缓存 key 与过期判断 */
function optionsSignature(options?: RedInkFilterOptions): string {
    if (!options) return "default";
    return [
        options.hueCenter ?? 0,
        options.maxHueDistance ?? 25,
        options.minSaturation ?? 0.3,
        options.minBrightness ?? 0.2,
    ].join("-");
}

const cache = new Map<string, Promise<string>>();

// 串行队列：解码与像素处理是同步重活，逐张排队避免卡顿
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
}

/** 获取去红后的图片 dataURL（按参数缓存，永不 reject）；打印入口可在 window.print() 前 await 它 */
export function getRedFilteredImage(src: string, options?: RedInkFilterOptions): Promise<string> {
    const key = `${src}|${optionsSignature(options)}`;
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
export function useRedFilteredSrc(src: string | null, enabled: boolean, options?: RedInkFilterOptions): string | null {
    // 记录 {src, sig, url} 成对，src 或参数变化后旧结果自动失效
    const sig = optionsSignature(options);
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
    /** 取色校准生成的检测参数，缺省用内置默认 */
    options?: RedInkFilterOptions;
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
