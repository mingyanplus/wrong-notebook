"use client";

import { useEffect, useMemo, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { RedFilteredImage, getRedFilteredImage, useInkCalibration, InkCalibrationControls, MaskedOriginalImage } from "@/components/red-filtered-image";
import { groupByFirstTag } from "@/lib/knowledge-tags";
import { DIFFICULTY_LABELS } from "@/lib/variant-settings";
import { parseDueSortMode } from "@/lib/review-settings";
import type { DueReviewItem } from "@/types/api";
import type { ImageMask } from "@/lib/image-masks";
import type { DifficultyLevel } from "@/lib/ai/types";

/** /api/review/due?include=image 的完整返回形状（图片字段为打印专用） */
interface DueItem extends DueReviewItem {
    errorItem: DueReviewItem["errorItem"] & {
        originalImageUrl: string;
        imageMasks: ImageMask[];
        requiresImage: boolean | null;
    };
}

interface VariantItem {
    id: string;
    errorItemId: string;
    difficulty: DifficultyLevel;
    questionText: string;
    answerText: string;
    analysis: string;
}

/** 打印勾选行的难度顺序（常用档在前），展示名走 t.reviewPrint.variantLevels */
const VARIANT_LEVELS: DifficultyLevel[] = ["medium", "hard", "harder", "easy"];

/** 题干是否需要配原图：与组卷打印 smart 模式同口径——AI 判定的 requiresImage
 *  （null=未判断，保守显示；仅明确 false 才隐藏，纯文字题不占版面） */
function imageNeededFor(item: DueItem["errorItem"]): boolean {
    return item.requiresImage !== false;
}

/** 估算文本打印行数（正文列约 40 字/行） */
function estimateLines(text: string | null | undefined): number {
    if (!text) return 1;
    return Math.max(1, Math.ceil(text.replace(/\s+/g, "").length / 40));
}

/** 作答留白高度随题长自适应：短题小留白，浏览器自然分页可排 3-5 题/页；长题/带图保持充足留白 */
function answerSpaceClass(lines: number, hasImage: boolean): string {
    if (!hasImage && lines <= 4) return "h-20";
    if (lines <= 8) return "h-28";
    return "h-36";
}

/**
 * 今日复习卷打印页（纸质复习闭环）：
 * 到期题目按知识点分组打印（题干 + 去红原图 + 作答留白），
 * 做完后回到错题本横幅逐题录对/错（POST /api/review/complete）。
 */
function ReviewPrintContent() {
    const searchParams = useSearchParams();
    const { t } = useLanguage();
    const [items, setItems] = useState<DueItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [redFilter, setRedFilter] = useState(true);
    const calibration = useInkCalibration(t.inkCalibration?.fail || "该处未检测到明显的笔迹颜色，请点击红笔笔迹中心重试");
    const { picking, redFilterOptions, pickFrom } = calibration;

    const [variants, setVariants] = useState<VariantItem[]>([]);
    // 打印勾选：各难度附加变式数量（默认全 0 = 不附加）
    const [variantCounts, setVariantCounts] = useState<Record<string, number>>({});
    // 原图显示比例（与错题本打印页同款滑杆），打印时同样生效
    const [imageScale, setImageScale] = useState(55);

    useEffect(() => {
        const query = searchParams.toString();
        apiClient
            .get<{ count: number; items: DueItem[] }>(`/api/review/due${query ? `?${query}&` : "?"}include=image`)
            .then((data) => setItems(data.items || []))
            .catch(() => {})
            .finally(() => setLoading(false));
    }, [searchParams]);

    // 变式题库懒加载：任一难度勾选 >0 才拉取（默认全 0 不预取全量题库）
    const variantsNeeded = useMemo(
        () => Object.values(variantCounts).some((n) => (n ?? 0) > 0),
        [variantCounts]
    );
    const [variantsFetched, setVariantsFetched] = useState(false);
    useEffect(() => {
        if (!variantsNeeded || variantsFetched || items.length === 0) return;
        setVariantsFetched(true); // 立即置位防重复请求；失败靠用户再调整勾选重试
        const ids = items.slice(0, 100).map((i) => i.errorItem.id); // 与 API 的 100 题上限对齐
        apiClient
            .get<{ items: VariantItem[] }>(`/api/variants?errorItemIds=${ids.join(",")}`)
            .then((v) => setVariants(v.items || []))
            .catch(() => {});
    }, [variantsNeeded, variantsFetched, items]);

    // 每题选中的变式（各难度取最新 N 条，题库按 createdAt 降序）
    const selectedVariantsByItem = useMemo(() => {
        const map = new Map<string, VariantItem[]>();
        const counters = new Map<string, number>();
        for (const v of variants) {
            const n = variantCounts[v.difficulty] ?? 0;
            if (n <= 0) continue;
            const key = `${v.errorItemId}:${v.difficulty}`;
            const c = counters.get(key) ?? 0;
            if (c >= n) continue;
            counters.set(key, c + 1);
            const list = map.get(v.errorItemId) ?? [];
            list.push(v);
            map.set(v.errorItemId, list);
        }
        return map;
    }, [variants, variantCounts]);

    // 卷面排序：知识点模式按知识点分组，随机/顺序/倒序平铺（数据顺序由 /api/review/due?sort= 决定）
    const sortMode = parseDueSortMode(searchParams.get("sort"));

    // 按知识点分组（首个标签，无标签归「未分类」），与错题本横幅口径一致（共享 groupByFirstTag）；仅知识点模式使用
    const groups = useMemo(
        () =>
            sortMode === "tag"
                ? Array.from(groupByFirstTag(items, (d) => d.errorItem.knowledgeTags, t.filter?.dueUngrouped || "未分类").entries())
                : [],
        [items, sortMode, t.filter?.dueUngrouped]
    );

    const handlePrint = async () => {
        if (redFilter && !picking) {
            // 等待将要显示的原图完成去红（命中缓存则立即返回），避免打印到未处理的原图；
            // 纯文字题不显示原图，也不必处理
            await Promise.all(
                items
                    .filter((i) => i.errorItem.originalImageUrl && imageNeededFor(i.errorItem))
                    .map((i) => getRedFilteredImage(i.errorItem.originalImageUrl, redFilterOptions))
            );
        }
        window.print();
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (items.length === 0) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4">
                <p className="text-muted-foreground">{t.reviewPrint?.empty || "当前没有到期待复习的题目"}</p>
                <BackButton fallbackUrl="/notebooks" />
            </div>
        );
    }

    let seq = 0; // 全卷连续题号

    // 单题块（分组与平铺两种渲染共用；seq 闭包递增保证全卷连续题号）
    const renderItem = (d: DueItem) => {
        const no = ++seq;
        const showImage = !!d.errorItem.originalImageUrl && imageNeededFor(d.errorItem);
        const questionLines = estimateLines(d.errorItem.questionText);
        return (
            <div key={d.errorItem.id} className="mb-6 print:break-inside-avoid">
                <div className="flex gap-2">
                    <span className="shrink-0 text-sm font-medium pt-0.5">{no}.</span>
                    <div className="flex-1 min-w-0">
                        <div className="prose prose-sm max-w-none">
                            <MarkdownRenderer content={d.errorItem.questionText || "（无题干）"} />
                        </div>
                        {showImage && (
                            <MaskedOriginalImage
                                src={d.errorItem.originalImageUrl}
                                masks={d.errorItem.imageMasks}
                                redFilterEnabled={redFilter}
                                options={redFilterOptions}
                                picking={picking}
                                onPick={pickFrom}
                                className="mt-2"
                                style={{ maxWidth: `${imageScale}%` }}
                            />
                        )}
                        {/* 作答留白（高度随题长自适应，短题多题同页） */}
                        <div className={`mt-3 ${answerSpaceClass(questionLines, showImage)} border-t border-dashed border-gray-300 dark:border-gray-600 print:border-gray-300`} />
                        {/* 附加变式题（勾选的难度数量，紧跟源题练同类）；卷面只标序号不标难度，避免孩子做题前受难度暗示 */}
                        {selectedVariantsByItem.get(d.errorItem.id)?.map((v, idx) => (
                            <div key={v.id} className="mt-4 print:break-inside-avoid">
                                <div className="mb-1">
                                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                                        {(t.reviewPrint?.variantLabel || "变式{n}").replace("{n}", String(idx + 1))}
                                    </span>
                                </div>
                                <div className="prose prose-sm max-w-none">
                                    <MarkdownRenderer content={v.questionText || "（无题干）"} />
                                </div>
                                <div className={`mt-3 ${answerSpaceClass(estimateLines(v.questionText), false)} border-t border-dashed border-gray-300 dark:border-gray-600 print:border-gray-300`} />
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    };

    return (
        <>
            {/* Print Controls - Hidden when printing */}
            <div className="print:hidden sticky top-0 z-10 bg-background border-b p-3 sm:p-4 shadow-sm">
                <div className="max-w-4xl mx-auto space-y-3">
                    <div className="flex items-center gap-3">
                        <BackButton fallbackUrl="/notebooks" />
                        <h1 className="text-lg sm:text-xl font-bold flex-1">
                            {t.reviewPrint?.title || "今日复习卷"}（{items.length} {t.filter?.dueItems || "题"}）
                        </h1>
                        <Button onClick={handlePrint} size="sm" className="whitespace-nowrap">
                            <Printer className="mr-1 h-4 w-4" />
                            {t.reviewPrint?.print || "打印 / 保存 PDF"}
                        </Button>
                    </div>

                    {/* Controls Row */}
                    <div className="flex flex-wrap items-center gap-2 sm:gap-4">
                        <label
                            className="flex items-center gap-1.5 text-xs sm:text-sm cursor-pointer whitespace-nowrap hover:text-primary transition-colors"
                            title={t.inkCalibration?.filterHint || "打印时自动滤除红笔痕迹；若题目本身的红色内容被误除，可关闭"}
                        >
                            <input
                                type="checkbox"
                                checked={redFilter}
                                onChange={(e) => setRedFilter(e.target.checked)}
                                className="rounded border-gray-300 text-primary focus:ring-primary w-3.5 h-3.5 sm:w-4 sm:h-4"
                            />
                            {t.inkCalibration?.filter || "红笔过滤"}
                        </label>
                        <InkCalibrationControls calibration={calibration} />
                        {/* 图片比例：与错题本打印页同款 */}
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="whitespace-nowrap">{t.printPreview?.imageScale || "图片比例"}: {imageScale}%</span>
                            <input
                                type="range"
                                min="30"
                                max="100"
                                value={imageScale}
                                onChange={(e) => setImageScale(Number(e.target.value))}
                                className="w-16 accent-primary cursor-pointer"
                            />
                        </label>
                        {/* 举一反三：从变式题库按难度/数量附加（在设置中开启自动生成后题库逐步充实） */}
                        <div
                            className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                            title={t.reviewPrint?.variantsHint || "在原题后附加变式题（数量取决于后台已生成的题库）"}
                        >
                            <span className="whitespace-nowrap font-medium">{t.reviewPrint?.variants || "举一反三"}</span>
                            {VARIANT_LEVELS.map((level) => (
                                <label key={level} className="flex items-center gap-1 cursor-pointer">
                                    <span className="whitespace-nowrap">
                                        {t.reviewPrint?.variantLevels?.[level] ?? DIFFICULTY_LABELS[level]}
                                    </span>
                                    <select
                                        value={variantCounts[level] ?? 0}
                                        onChange={(e) =>
                                            setVariantCounts((p) => ({ ...p, [level]: Number(e.target.value) }))
                                        }
                                        className="rounded border bg-background px-1 py-0.5"
                                    >
                                        {[0, 1, 2, 3].map((n) => (
                                            <option key={n} value={n}>
                                                {n}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            ))}
                        </div>
                    </div>
                    {picking && (
                        <div className="rounded border border-dashed border-primary/50 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                            {t.inkCalibration?.pickHint || "点击原图中的红笔痕迹取样（当前显示未过滤原图），可连续点击多个位置覆盖深浅；按 Esc 结束"}
                        </div>
                    )}
                </div>
            </div>

            {/* Print Content */}
            <div className="max-w-4xl mx-auto p-8 print:p-0">
                {/* 卷头（打印时显示） */}
                <div className="mb-8 text-center">
                    <h2 className="text-xl font-bold">{t.reviewPrint?.title || "今日复习卷"}</h2>
                    <p className="text-sm mt-1 text-muted-foreground">
                        {new Date().toLocaleDateString("zh-CN")} · {items.length} {t.filter?.dueItems || "题"}
                    </p>
                </div>

                {sortMode === "tag"
                    ? groups.map(([tag, groupItems]) => (
                          <div key={tag} className="mb-6">
                              <h3 className="font-bold text-base mb-3 border-b pb-2 print:break-after-avoid">
                                  {tag}（{groupItems.length} {t.filter?.dueItems || "题"}）
                              </h3>
                              {groupItems.map(renderItem)}
                          </div>
                      ))
                    : items.map(renderItem)}
            </div>
        </>
    );
}

export default function ReviewPrintPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen flex items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
            }
        >
            <ReviewPrintContent />
        </Suspense>
    );
}
