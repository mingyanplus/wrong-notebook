"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import type { ImageMask } from "@/lib/image-masks";

interface ImageMaskEditorProps {
    errorItemId: string;
    imageUrl: string;
    initialMasks: ImageMask[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved?: (masks: ImageMask[]) => void;
}

/**
 * 原题图片打印遮罩标注器：在图片上拖拽画矩形，圈出作答痕迹/红笔批改，
 * 坐标按 0-1 归一化存储，打印渲染时按百分比定位（屏幕/打印任意缩放下精确对位）。
 */
export function ImageMaskEditor({ errorItemId, imageUrl, initialMasks, open, onOpenChange, onSaved }: ImageMaskEditorProps) {
    const { t } = useLanguage();
    const [masks, setMasks] = useState<ImageMask[]>(initialMasks);
    const [draft, setDraft] = useState<ImageMask | null>(null);
    const [saving, setSaving] = useState(false);
    const dragStart = useRef<{ x: number; y: number } | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (open) setMasks(initialMasks);
    }, [open, initialMasks]);

    const toNormalized = (e: React.PointerEvent): { x: number; y: number } => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
        return {
            x: clamp01((e.clientX - rect.left) / rect.width),
            y: clamp01((e.clientY - rect.top) / rect.height),
        };
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        dragStart.current = toNormalized(e);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!dragStart.current) return;
        const p = toNormalized(e);
        const s = dragStart.current;
        setDraft({
            x: Math.min(s.x, p.x),
            y: Math.min(s.y, p.y),
            w: Math.abs(p.x - s.x),
            h: Math.abs(p.y - s.y),
        });
    };

    const handlePointerUp = () => {
        // 过小的误触框（<0.5% 宽或高）不落库
        if (draft && draft.w > 0.005 && draft.h > 0.005) {
            setMasks((arr) => [...arr, draft]);
        }
        dragStart.current = null;
        setDraft(null);
    };

    const save = async () => {
        setSaving(true);
        try {
            await apiClient.put(`/api/error-items/${errorItemId}`, { imageMasks: masks });
            onSaved?.(masks);
            onOpenChange(false);
        } catch {
            alert(t.common?.error || "保存失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>遮盖作答痕迹</DialogTitle>
                </DialogHeader>
                <p className="text-xs text-muted-foreground">
                    在图片上拖拽画出需要遮盖的区域（手写作答、红笔批改等），打印时这些区域会被白色覆盖；多个矩形可拼出任意形状。悬停遮罩可单独删除。
                </p>
                <div
                    ref={containerRef}
                    className="relative touch-none select-none cursor-crosshair overflow-hidden rounded border bg-muted"
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerLeave={handlePointerUp}
                >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageUrl} alt="原题" className="block w-full" draggable={false} />
                    {masks.map((m, i) => (
                        <div
                            key={i}
                            className="group absolute pointer-events-none"
                            style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` }}
                        >
                            <div className="absolute inset-0 border border-dashed border-gray-400 bg-white/90" />
                            <button
                                type="button"
                                className="absolute -top-1 -right-1 hidden h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs text-white group-hover:flex pointer-events-auto"
                                onClick={() => setMasks((arr) => arr.filter((_, j) => j !== i))}
                                aria-label="删除此遮罩"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </div>
                    ))}
                    {draft && (
                        <div
                            className="absolute pointer-events-none border border-blue-500 bg-blue-500/20"
                            style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }}
                        />
                    )}
                </div>
                <DialogFooter>
                    <span className="mr-auto text-xs text-muted-foreground">已添加 {masks.length} 个遮罩</span>
                    <Button variant="outline" size="sm" onClick={() => setMasks([])} disabled={!masks.length || saving}>
                        清除全部
                    </Button>
                    <Button onClick={save} disabled={saving}>
                        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {t.common?.save || "保存"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
