"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { apiClient } from "@/lib/api-client";
import { ErrorItem, PaginatedResponse } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { PRINT_PREVIEW_PAGE_SIZE } from "@/lib/constants/pagination";
import { RedFilteredImage, getRedFilteredImage, sampleRedInkFromImage } from "@/components/red-filtered-image";
import { redInkOptionsFromSample } from "@/lib/image-color-filter";
import type { RedInkFilterOptions } from "@/lib/image-color-filter";
import { Pipette } from "lucide-react";
import {
    getPrintPreviewCountLabel,
    getPrintPreviewEmptyState,
    getSelectedPrintItems,
    shouldReserveAnswerSpace,
} from "@/lib/print-preview";

function PrintPreviewContent() {
    const searchParams = useSearchParams();
    const { t } = useLanguage();
    const [items, setItems] = useState<ErrorItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [showAnswers, setShowAnswers] = useState(false);
    const [showAnalysis, setShowAnalysis] = useState(false);
    const [showTags, setShowTags] = useState(false);
    const [imageScale, setImageScale] = useState(70);
    const [showQuestionText, setShowQuestionText] = useState(false);
    // 红笔过滤：打印前自动滤除图片中的红笔订正痕迹，防止孩子重做时看到答案
    const [redFilter, setRedFilter] = useState(true);
    // 取色校准：null=内置默认参数；取样后以该颜色为中心生成检测范围（拍摄色偏时用）
    const [redFilterOptions, setRedFilterOptions] = useState<RedInkFilterOptions | null>(null);
    const [picking, setPicking] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    useEffect(() => {
        fetchItems();
    }, []);

    // 取色模式按 Esc 退出
    useEffect(() => {
        if (!picking) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setPicking(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [picking]);
    const fetchItems = async () => {
        try {
            const params = new URLSearchParams(searchParams.toString());
            // 打印预览需要所有符合条件的数据，设置较大的 pageSize
            params.set("pageSize", String(PRINT_PREVIEW_PAGE_SIZE));
            const response = await apiClient.get<PaginatedResponse<ErrorItem>>(`/api/error-items/list?${params.toString()}`);
            setItems(response.items);
            setSelectedIds(new Set(response.items.map((item) => item.id)));
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    const handlePrint = async () => {
        // 等待将打印的图片完成去红处理（与下方渲染条件一致：显示原图且未被文字替代的项）
        if (redFilter) {
            const pending = selectedItems
                .filter((item) => item.originalImageUrl && !(showQuestionText && item.questionText))
                .map((item) => getRedFilteredImage(item.originalImageUrl as string, redFilterOptions ?? undefined));
            await Promise.all(pending);
        }
        window.print();
    };

    // 取色校准：点击原图上的红笔痕迹，以该颜色为中心重新生成全部图片的检测范围
    const handlePick = async (e: React.MouseEvent<HTMLImageElement>, src: string) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const sample = await sampleRedInkFromImage(
            src,
            (e.clientX - rect.left) / rect.width,
            (e.clientY - rect.top) / rect.height
        );
        if (!sample) {
            alert(t.printPreview?.pickColorFail || 'No obvious ink color detected at that spot. Click the center of a red mark and retry.');
            return;
        }
        setRedFilterOptions(redInkOptionsFromSample(sample));
        setPicking(false);
    };

    const selectedItems = getSelectedPrintItems(items, selectedIds);
    const reserveAnswerSpace = shouldReserveAnswerSpace(showAnswers, showAnalysis);
    const countLabel = getPrintPreviewCountLabel(items.length, selectedItems.length);
    const emptyState = getPrintPreviewEmptyState(items.length, selectedItems.length);

    const toggleSelectedItem = (id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const selectAllItems = () => {
        setSelectedIds(new Set(items.map((item) => item.id)));
    };

    const clearSelectedItems = () => {
        setSelectedIds(new Set());
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <p className="text-muted-foreground">{t.common.loading}</p>
            </div>
        );
    }

    return (
        <>
            {/* Print Controls - Hidden when printing */}
            <div className="print:hidden sticky top-0 z-10 bg-background border-b p-3 sm:p-4 shadow-sm">
                <div className="max-w-6xl mx-auto space-y-3">
                    {/* Header Row */}
                    <div className="flex items-center gap-3">
                        <BackButton fallbackUrl="/notebooks" />
                        <h1 className="text-lg sm:text-xl font-bold flex-1">
                            {t.printPreview?.title || 'Print Preview'} ({countLabel} {t.notebooks?.items || 'items'})
                        </h1>
                        <Button onClick={handlePrint} size="sm" className="whitespace-nowrap" disabled={selectedItems.length === 0}>
                            {t.printPreview?.printButton || 'Print / Save PDF'}
                        </Button>
                    </div>

                    {/* Controls Row */}
                    <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-4">
                        {/* Image Scale Control */}
                        <div className="flex items-center gap-2 text-sm bg-muted/50 px-2 sm:px-3 py-1 rounded-md">
                            <span className="whitespace-nowrap text-xs sm:text-sm">{t.printPreview?.imageScale || 'Image Scale'}: {imageScale}%</span>
                            <input
                                type="range"
                                min="30"
                                max="100"
                                value={imageScale}
                                onChange={(e) => setImageScale(Number(e.target.value))}
                                className="w-16 sm:w-20 accent-primary"
                            />
                        </div>

                        {/* Toggle Options - Grid on Mobile */}
                        <div className="flex flex-wrap gap-x-3 gap-y-1 sm:gap-4">
                            <label className="flex items-center gap-1.5 text-xs sm:text-sm cursor-pointer whitespace-nowrap hover:text-primary transition-colors" title={t.printPreview?.redFilterHint || 'Automatically remove red ink marks when printing. Disable if red content in the question itself is removed.'}>
                                <input
                                    type="checkbox"
                                    checked={redFilter}
                                    onChange={(e) => setRedFilter(e.target.checked)}
                                    className="rounded border-gray-300 text-primary focus:ring-primary w-3.5 h-3.5 sm:w-4 sm:h-4"
                                />
                                {t.printPreview?.redFilter || 'Red Ink Filter'}
                            </label>
                            <label className="flex items-center gap-1.5 text-xs sm:text-sm cursor-pointer whitespace-nowrap hover:text-primary transition-colors">
                                <input
                                    type="checkbox"
                                    checked={showQuestionText}
                                    onChange={(e) => setShowQuestionText(e.target.checked)}
                                    className="rounded border-gray-300 text-primary focus:ring-primary w-3.5 h-3.5 sm:w-4 sm:h-4"
                                />
                                {t.printPreview?.showQuestionText || 'Question Text'}
                            </label>
                            <label className="flex items-center gap-1.5 text-xs sm:text-sm cursor-pointer whitespace-nowrap hover:text-primary transition-colors">
                                <input
                                    type="checkbox"
                                    checked={showAnswers}
                                    onChange={(e) => setShowAnswers(e.target.checked)}
                                    className="rounded border-gray-300 text-primary focus:ring-primary w-3.5 h-3.5 sm:w-4 sm:h-4"
                                />
                                {t.printPreview?.showAnswers || 'Show Answers'}
                            </label>
                            <label className="flex items-center gap-1.5 text-xs sm:text-sm cursor-pointer whitespace-nowrap hover:text-primary transition-colors">
                                <input
                                    type="checkbox"
                                    checked={showAnalysis}
                                    onChange={(e) => setShowAnalysis(e.target.checked)}
                                    className="rounded border-gray-300 text-primary focus:ring-primary w-3.5 h-3.5 sm:w-4 sm:h-4"
                                />
                                {t.printPreview?.showAnalysis || 'Show Analysis'}
                            </label>
                            <label className="flex items-center gap-1.5 text-xs sm:text-sm cursor-pointer whitespace-nowrap hover:text-primary transition-colors">
                                <input
                                    type="checkbox"
                                    checked={showTags}
                                    onChange={(e) => setShowTags(e.target.checked)}
                                    className="rounded border-gray-300 text-primary focus:ring-primary w-3.5 h-3.5 sm:w-4 sm:h-4"
                                />
                                {t.printPreview?.showTags || 'Show Tags'}
                            </label>
                        </div>
                        {/* 取色校准（红笔颜色因拍摄色偏而滤不净时，点击图上笔迹重新校准） */}
                        <div className="flex items-center gap-1.5">
                            <Button
                                variant={picking ? "default" : "outline"}
                                size="sm"
                                className="h-7 gap-1 px-2 text-xs"
                                onClick={() => setPicking((p) => !p)}
                                title={t.printPreview?.pickColorHint || 'Click a red ink mark on any image to re-calibrate the filter (images are shown unfiltered while picking). Esc to cancel.'}
                            >
                                <Pipette className="h-3.5 w-3.5" />
                                {picking
                                    ? t.printPreview?.pickColorActive || 'Click red ink… (Esc)'
                                    : redFilterOptions
                                        ? t.printPreview?.pickColorDone || 'Ink Calibrated'
                                        : t.printPreview?.pickColor || 'Ink Calibrate'}
                            </Button>
                            {redFilterOptions && !picking && (
                                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setRedFilterOptions(null)}>
                                    {t.printPreview?.resetCalibration || 'Reset'}
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* Item Selection Row */}
                    <div className="rounded-md border bg-muted/20 p-3 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-medium">
                                {t.printPreview?.selectItems || 'Select Items'} ({selectedItems.length}/{items.length})
                            </div>
                            <div className="flex gap-2">
                                <Button variant="outline" size="sm" onClick={selectAllItems}>
                                    {t.printPreview?.selectAll || 'Select All'}
                                </Button>
                                <Button variant="outline" size="sm" onClick={clearSelectedItems}>
                                    {t.printPreview?.clearSelection || 'Clear Selection'}
                                </Button>
                            </div>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 max-h-44 overflow-y-auto pr-1">
                            {items.map((item, index) => (
                                <label
                                    key={item.id}
                                    className="flex items-start gap-2 rounded border bg-background p-2 text-xs cursor-pointer hover:border-primary/50"
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.has(item.id)}
                                        onChange={() => toggleSelectedItem(item.id)}
                                        className="mt-0.5 rounded border-gray-300 text-primary focus:ring-primary"
                                    />
                                    <span className="line-clamp-2">
                                        <span className="font-semibold">
                                            {t.printPreview?.questionNumber?.replace('{num}', String(index + 1)) || `Question ${index + 1}`}
                                        </span>
                                        {item.questionText ? `：${item.questionText}` : ''}
                                    </span>
                                </label>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* Print Content */}
            <div className="max-w-4xl mx-auto p-8 print:p-0">
                {selectedItems.map((item, index) => {
                    // 优先使用 tags 关联，回退到 knowledgePoints
                    let tags: string[] = [];
                    if (item.tags && item.tags.length > 0) {
                        tags = item.tags.map(t => t.name);
                    } else {
                        try {
                            tags = JSON.parse(item.knowledgePoints || "[]");
                        } catch (e) {
                            tags = [];
                        }
                    }

                    return (
                        <div
                            key={item.id}
                            className={`mb-4 border-b last:border-b-0 print:break-inside-avoid ${reserveAnswerSpace ? "pb-20 print:pb-16" : "pb-6"}`}
                        >
                            {/* Question Header */}
                            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 leading-7">
                                <span className="text-lg font-bold">
                                    {t.printPreview?.questionNumber?.replace('{num}', String(index + 1)) || `Question ${index + 1}`}
                                </span>
                                {item.subject && (
                                    <span className="text-sm text-muted-foreground">
                                        {item.subject.name}
                                    </span>
                                )}
                                {item.gradeSemester && (
                                    <span className="text-sm text-muted-foreground">
                                        {item.gradeSemester}
                                    </span>
                                )}
                                {item.paperLevel && (
                                    <span className="text-sm text-muted-foreground">
                                        {t.printPreview?.paperLevel || 'Paper Level'}: {item.paperLevel.toUpperCase()}
                                    </span>
                                )}
                                {showTags && tags.length > 0 && (
                                    <>
                                        <span className="font-semibold">
                                            {t.printPreview?.knowledgePoints || 'Knowledge Points'}:
                                        </span>
                                        {tags.map((tag, tagIndex) => (
                                            <span
                                                key={`${tag}-${tagIndex}`}
                                                className="px-2 py-1 bg-muted rounded text-sm"
                                            >
                                                {tag}
                                            </span>
                                        ))}
                                    </>
                                )}
                            </div>

                            {/* Original Image or Text */}
                            {showQuestionText && item.questionText ? (
                                <div className="mb-4">
                                    <MarkdownRenderer content={item.questionText} />
                                </div>
                            ) : (
                                item.originalImageUrl && (
                                    <div className="mb-4">
                                        <RedFilteredImage
                                            src={item.originalImageUrl}
                                            enabled={redFilter && !picking}
                                            options={redFilterOptions ?? undefined}
                                            alt={t.detail?.originalProblem || 'Question Image'}
                                            className={`h-auto border rounded ${picking ? "cursor-crosshair" : ""}`}
                                            style={{ maxWidth: `${imageScale}%` }}
                                            onClick={picking ? (e) => handlePick(e, item.originalImageUrl as string) : undefined}
                                        />
                                    </div>
                                )
                            )}



                            {/* Answer */}
                            {showAnswers && item.answerText && (
                                <div className="mb-4">
                                    <h3 className="font-semibold mb-2">{t.printPreview?.referenceAnswer || 'Reference Answer'}:</h3>
                                    <MarkdownRenderer content={item.answerText} />
                                </div>
                            )}

                            {/* Analysis */}
                            {showAnalysis && item.analysis && (
                                <div className="mb-4">
                                    <h3 className="font-semibold mb-2">{t.printPreview?.analysis || 'Analysis'}:</h3>
                                    <MarkdownRenderer content={item.analysis} />
                                </div>
                            )}
                        </div>
                    );
                })}

                {emptyState && (
                    <div className="text-center py-12 text-muted-foreground">
                        {emptyState === 'noSelection'
                            ? (t.printPreview?.noSelection || 'No items selected')
                            : (t.printPreview?.noItems || 'No matching error items')}
                    </div>
                )}
            </div>
        </>
    );
}

export default function PrintPreviewPage() {
    const { t } = useLanguage();
    return (
        <Suspense fallback={<div className="min-h-screen flex items-center justify-center">{t.common.loading}</div>}>
            <PrintPreviewContent />
        </Suspense>
    );
}
