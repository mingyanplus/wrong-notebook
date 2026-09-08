"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { Crop as CropIcon, Hand, Trash2, X } from "lucide-react";

/** 显示坐标下的矩形（相对 overlay，即图片显示尺寸） */
interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

interface MultiQuestionCropperProps {
    imageSrc: string;
    open: boolean;
    onClose: () => void;
    onCropsComplete: (croppedImages: Blob[]) => void;
}

/** 画框最小尺寸（显示像素），小于此值视为误触 */
const MIN_BOX_SIZE = 16;

export function MultiQuestionCropper({
    imageSrc,
    open,
    onClose,
    onCropsComplete,
}: MultiQuestionCropperProps) {
    const { t } = useLanguage();
    const mc = t.common.multiCapture;

    const [boxes, setBoxes] = useState<Box[]>([]);
    const [draft, setDraft] = useState<Box | null>(null);
    const [panMode, setPanMode] = useState(false);
    const [imgLoaded, setImgLoaded] = useState(false);
    const [cropping, setCropping] = useState(false);

    const imgRef = useRef<HTMLImageElement>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const startPoint = useRef<{ x: number; y: number } | null>(null);

    /** 指针位置换算为 overlay 本地坐标，并 clamp 到图片边界内 */
    const getLocalPoint = (e: React.PointerEvent): { x: number; y: number } => {
        const rect = overlayRef.current!.getBoundingClientRect();
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
        return { x, y };
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        if (panMode || !imgLoaded) return;
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
            // 指针不可捕获（如合成事件）时忽略，仅影响跨元素拖动跟踪
        }
        const p = getLocalPoint(e);
        startPoint.current = p;
        setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!startPoint.current) return;
        const p = getLocalPoint(e);
        const start = startPoint.current;
        setDraft({
            x: Math.min(start.x, p.x),
            y: Math.min(start.y, p.y),
            w: Math.abs(p.x - start.x),
            h: Math.abs(p.y - start.y),
        });
    };

    const handlePointerUp = () => {
        if (!startPoint.current || !draft) return;
        startPoint.current = null;
        if (draft.w >= MIN_BOX_SIZE && draft.h >= MIN_BOX_SIZE) {
            setBoxes((prev) => [...prev, draft]);
        }
        setDraft(null);
    };

    /** 按显示坐标矩形裁剪原图（换算 natural 尺寸），输出 jpeg Blob */
    const cropRect = async (box: Box): Promise<Blob> => {
        const image = imgRef.current;
        if (!image) throw new Error("Image not loaded");
        const scaleX = image.naturalWidth / image.clientWidth;
        const scaleY = image.naturalHeight / image.clientHeight;
        const sx = Math.round(box.x * scaleX);
        const sy = Math.round(box.y * scaleY);
        const sw = Math.max(1, Math.min(Math.round(box.w * scaleX), image.naturalWidth - sx));
        const sh = Math.max(1, Math.min(Math.round(box.h * scaleY), image.naturalHeight - sy));

        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas is empty");

        ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error("Canvas is empty"));
                    return;
                }
                resolve(blob);
            }, "image/jpeg");
        });
    };

    const handleConfirm = async () => {
        if (boxes.length === 0 || cropping) return;
        setCropping(true);
        try {
            // 按阅读顺序排序：先上后下、同行先左后右（兼容两栏试卷）
            const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
            const blobs: Blob[] = [];
            for (const box of sorted) {
                blobs.push(await cropRect(box));
            }
            if (blobs.length > 0) {
                setBoxes([]);
                setDraft(null);
                onCropsComplete(blobs);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setCropping(false);
        }
    };

    const renderBox = (box: Box, i: number, isDraft: boolean) => (
        <div
            key={isDraft ? "draft" : i}
            className={`absolute border-2 pointer-events-none ${
                isDraft ? "border-primary/70 bg-primary/5" : "border-primary bg-primary/10"
            }`}
            style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
        >
            {!isDraft && (
                <>
                    <span className="absolute -top-3 -left-3 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center shadow">
                        {i + 1}
                    </span>
                    <button
                        type="button"
                        title={mc?.deleteBox || "删除此框"}
                        className="absolute -top-3 left-4 h-6 w-6 rounded-full bg-destructive text-white flex items-center justify-center shadow pointer-events-auto"
                        onClick={(e) => {
                            e.stopPropagation();
                            setBoxes((prev) => prev.filter((_, j) => j !== i));
                        }}
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </>
            )}
        </div>
    );

    return (
        <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
            <DialogContent className="max-w-3xl h-[90vh] flex flex-col p-0 gap-0">
                <DialogHeader className="p-4 border-b shrink-0 space-y-2">
                    <DialogTitle>{mc?.title || "多题框选"}</DialogTitle>
                    <div className="flex items-center gap-2">
                        <Button
                            variant={panMode ? "default" : "outline"}
                            size="sm"
                            onClick={() => setPanMode(!panMode)}
                            title={panMode ? mc?.cropMode || "框选" : mc?.panMode || "平移"}
                        >
                            {panMode ? <CropIcon className="h-4 w-4" /> : <Hand className="h-4 w-4" />}
                            {panMode ? mc?.cropMode || "框选" : mc?.panMode || "平移"}
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setBoxes([])}
                            disabled={boxes.length === 0 || cropping}
                        >
                            <Trash2 className="h-4 w-4" />
                            {mc?.clearAll || "清空"}
                        </Button>
                    </div>
                </DialogHeader>

                <div className="flex-1 bg-black w-full overflow-auto flex justify-center p-4">
                    <div className="relative inline-block max-w-full">
                    {/* eslint-disable-next-line @next/next/no-img-element -- blob url 源图，next/image 不适用 */}
                    <img
                        ref={imgRef}
                            alt="multi-crop"
                            src={imageSrc}
                            draggable={false}
                            onLoad={() => setImgLoaded(true)}
                            style={{ maxHeight: "60vh", maxWidth: "100%", objectFit: "contain" }}
                        />
                        <div
                            ref={overlayRef}
                            className={`absolute inset-0 ${panMode ? "pointer-events-none" : "cursor-crosshair"}`}
                            style={{ touchAction: "none", userSelect: "none" }}
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={handlePointerUp}
                            onPointerCancel={handlePointerUp}
                        >
                            {boxes.map((box, i) => renderBox(box, i, false))}
                            {draft && renderBox(draft, boxes.length, true)}
                        </div>
                    </div>
                </div>

                <div className="p-4 border-t bg-background shrink-0">
                    <div className="flex justify-between items-center gap-2">
                        <p className="text-sm text-muted-foreground">
                            {mc?.hint || "💡 在图片上拖拽框出每道题"}
                            {boxes.length > 0 && (
                                <span className="ml-2 font-medium text-foreground">
                                    {(mc?.selectedCount || "已框选 {n} 题").replace("{n}", String(boxes.length))}
                                </span>
                            )}
                        </p>
                        <div className="flex gap-2 shrink-0">
                            <Button variant="outline" onClick={onClose}>
                                {t.common.cancel || "Cancel"}
                            </Button>
                            <Button onClick={handleConfirm} disabled={boxes.length === 0 || cropping}>
                                {cropping
                                    ? (mc?.recognizing || "题目识别中")
                                    : `${mc?.confirm || "识别"} (${boxes.length})`}
                            </Button>
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
