"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CorrectionEditor } from "@/components/correction-editor";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { frontendLogger } from "@/lib/frontend-logger";
import { analyzeSingleBlob, MultiAnalyzeItem } from "@/lib/multi-analyze";
import type { ParsedQuestion } from "@/lib/ai";
import {
    Ban,
    CheckCircle2,
    CircleDashed,
    Loader2,
    Pencil,
    RotateCcw,
    Trash2,
    XCircle,
} from "lucide-react";

/** 结果面板在识别状态之外补充的本地终态 */
type PanelOverride = "saved" | "skipped";

/** 编辑入库时 CorrectionEditor 回传的扩展字段 */
type EditorData = ParsedQuestion & {
    subjectId?: string;
    gradeSemester?: string;
    paperLevel?: string;
    source?: string;
    geogebraCommands?: string;
};

interface MultiResultsPanelProps {
    /** 原始裁剪框（失败题重试用，与 items.index-1 对应） */
    blobs: Blob[];
    items: MultiAnalyzeItem[];
    defaultSubjectId?: string;
    aiTimeout: number;
    onFinished: (savedCount: number) => void;
    onDiscard: () => void;
}

export function MultiResultsPanel({
    blobs,
    items,
    defaultSubjectId,
    aiTimeout,
    onFinished,
    onDiscard,
}: MultiResultsPanelProps) {
    const { t, language } = useLanguage();
    const mc = t.common.multiCapture;

    const [liveItems, setLiveItems] = useState<MultiAnalyzeItem[]>(items);
    const [overrides, setOverrides] = useState<Record<number, PanelOverride>>({});
    const [retrying, setRetrying] = useState<Set<number>>(new Set());
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const [savingIndex, setSavingIndex] = useState<number | null>(null);

    const savedCount = Object.values(overrides).filter((s) => s === "saved").length;
    const skippedCount = Object.values(overrides).filter((s) => s === "skipped").length;
    const failedCount = liveItems.filter((it) => it.status === "failed" && !overrides[it.index]).length;
    // 待确认的成功题是否清零（失败题允许不处理直接完成）
    const unresolved = liveItems.filter((it) => !overrides[it.index] && it.status === "success").length;
    const canFinish = unresolved === 0;

    const setOverride = (index: number, status: PanelOverride) =>
        setOverrides((prev) => ({ ...prev, [index]: status }));

    const handleRetry = async (index: number) => {
        const blob = blobs[index - 1];
        if (!blob) return;
        setRetrying((prev) => new Set(prev).add(index));
        try {
            const { imageBase64, parsed } = await analyzeSingleBlob(blob, {
                language,
                subjectId: defaultSubjectId,
                timeout: aiTimeout,
            });
            setLiveItems((prev) =>
                prev.map((item) =>
                    item.index === index
                        ? { ...item, status: "success", imageBase64, parsed, error: undefined }
                        : item
                )
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLiveItems((prev) =>
                prev.map((item) => (item.index === index ? { ...item, status: "failed", error: message } : item))
            );
        } finally {
            setRetrying((prev) => {
                const next = new Set(prev);
                next.delete(index);
                return next;
            });
        }
    };

    const handleSave = async (data: EditorData, item: MultiAnalyzeItem): Promise<void> => {
        setSavingIndex(item.index);
        try {
            const result = await apiClient.post<{ id: string; duplicate?: boolean }>("/api/error-items", {
                ...data,
                originalImageUrl: item.imageBase64 || "",
            });
            if (result.duplicate) {
                frontendLogger.info("[MultiCapture]", "Duplicate detected, using existing record", {
                    index: item.index,
                });
            }
            setOverride(item.index, "saved");
            setEditingIndex(null);
        } catch (error) {
            frontendLogger.error("[MultiCapture]", "Save failed", {
                index: item.index,
                error: error instanceof Error ? error.message : String(error),
            });
            alert(t.common?.messages?.saveFailed || "保存失败");
        } finally {
            setSavingIndex(null);
        }
    };

    // 编辑态：复用单题 CorrectionEditor（错因/标签/题型确认流完全一致）
    const editingItem =
        editingIndex !== null ? liveItems.find((it) => it.index === editingIndex && it.status === "success") : undefined;

    if (editingItem && editingItem.parsed) {
        return (
            <div className="space-y-4">
                <CorrectionEditor
                    initialData={editingItem.parsed}
                    onSave={(data) => handleSave(data, editingItem)}
                    onCancel={() => setEditingIndex(null)}
                    imagePreview={editingItem.imageBase64 || null}
                    initialSubjectId={defaultSubjectId}
                    aiTimeout={aiTimeout}
                />
            </div>
        );
    }

    const statusBadge = (item: MultiAnalyzeItem) => {
        const override = overrides[item.index];
        if (override === "saved") {
            return (
                <Badge className="bg-emerald-600 hover:bg-emerald-600 gap-1">
                    <CheckCircle2 className="h-3 w-3" />
                    {mc?.statusSaved || "已入库"}
                </Badge>
            );
        }
        if (override === "skipped") {
            return (
                <Badge variant="secondary" className="gap-1">
                    <Ban className="h-3 w-3" />
                    {mc?.statusSkipped || "已跳过"}
                </Badge>
            );
        }
        if (retrying.has(item.index)) {
            return (
                <Badge variant="outline" className="gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {mc?.statusAnalyzing || "识别中"}
                </Badge>
            );
        }
        switch (item.status) {
            case "success":
                return (
                    <Badge className="gap-1">
                        <Pencil className="h-3 w-3" />
                        {mc?.statusSuccess || "待确认"}
                    </Badge>
                );
            case "failed":
                return (
                    <Badge variant="destructive" className="gap-1">
                        <XCircle className="h-3 w-3" />
                        {mc?.statusFailed || "失败"}
                    </Badge>
                );
            case "analyzing":
                return (
                    <Badge variant="outline" className="gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {mc?.statusAnalyzing || "识别中"}
                    </Badge>
                );
            default:
                return (
                    <Badge variant="secondary" className="gap-1">
                        <CircleDashed className="h-3 w-3" />
                        {mc?.statusPending || "等待中"}
                    </Badge>
                );
        }
    };

    const actions = (item: MultiAnalyzeItem) => {
        if (overrides[item.index]) return null;
        if (retrying.has(item.index)) return null;
        if (item.status === "success") {
            return (
                <Button size="sm" onClick={() => setEditingIndex(item.index)}>
                    <Pencil className="h-4 w-4" />
                    {mc?.editSave || "编辑入库"}
                </Button>
            );
        }
        if (item.status === "failed") {
            return (
                <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => handleRetry(item.index)}>
                        <RotateCcw className="h-4 w-4" />
                        {mc?.retry || "重试"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setOverride(item.index, "skipped")}>
                        <Ban className="h-4 w-4" />
                        {mc?.skip || "跳过"}
                    </Button>
                </div>
            );
        }
        return null;
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap justify-between items-center gap-2">
                <div>
                    <h2 className="text-lg font-semibold">{mc?.resultsTitle || "识别结果"}</h2>
                    <p className="text-sm text-muted-foreground">
                        {(mc?.summary || "共 {total} 题 · 已入库 {saved} · 已跳过 {skipped} · 失败 {failed}")
                            .replace("{total}", String(liveItems.length))
                            .replace("{saved}", String(savedCount))
                            .replace("{skipped}", String(skippedCount))
                            .replace("{failed}", String(failedCount))}
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            if (window.confirm(mc?.discardConfirm || "确定放弃全部识别结果吗？")) {
                                onDiscard();
                            }
                        }}
                    >
                        <Trash2 className="h-4 w-4" />
                        {mc?.discard || "放弃全部"}
                    </Button>
                    <Button size="sm" disabled={!canFinish || savingIndex !== null} onClick={() => onFinished(savedCount)}>
                        <CheckCircle2 className="h-4 w-4" />
                        {mc?.finish || "完成"}
                    </Button>
                </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
                {liveItems.map((item) => (
                    <Card key={item.index} className="overflow-hidden">
                        <CardContent className="flex gap-3 p-3">
                            {item.imageBase64 ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={item.imageBase64}
                                    alt={`question-${item.index}`}
                                    className="w-20 h-20 object-cover rounded border shrink-0"
                                />
                            ) : (
                                <div className="w-20 h-20 rounded border shrink-0 bg-muted flex items-center justify-center text-xs text-muted-foreground">
                                    {item.index}
                                </div>
                            )}
                            <div className="flex-1 min-w-0 flex flex-col gap-2">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-medium text-muted-foreground shrink-0">
                                        #{item.index}
                                    </span>
                                    {statusBadge(item)}
                                </div>
                                <p className="text-sm line-clamp-2 text-foreground/90 break-all">
                                    {item.parsed?.questionText ||
                                        (item.status === "failed" ? item.error || "" : "")}
                                </p>
                                <div className="mt-auto">{actions(item)}</div>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    );
}
