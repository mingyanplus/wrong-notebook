import { apiClient } from "@/lib/api-client";
import { processImageFile } from "@/lib/image-utils";
import type { ParsedQuestion } from "@/lib/ai";
import type { AnalyzeResponse } from "@/types/api";

/** 多题框选识别：单题识别状态 */
export type MultiAnalyzeStatus = "pending" | "analyzing" | "success" | "failed";

export interface MultiAnalyzeItem {
    /** 框序号（1 起，对应框选角标） */
    index: number;
    status: MultiAnalyzeStatus;
    /** 压缩后的图片（data url，用于缩略图展示与入库 originalImageUrl） */
    imageBase64?: string;
    parsed?: ParsedQuestion;
    error?: string;
}

export interface AnalyzeSingleOptions {
    language: string;
    subjectId?: string;
    timeout?: number;
}

/** 压缩并识别单个裁剪框 */
export async function analyzeSingleBlob(
    blob: Blob,
    options: AnalyzeSingleOptions
): Promise<{ imageBase64: string; parsed: ParsedQuestion }> {
    const file = new File([blob], `multi-crop-${Date.now()}.jpg`, { type: "image/jpeg" });
    const imageBase64 = await processImageFile(file);
    const parsed = await apiClient.post<AnalyzeResponse>(
        "/api/analyze",
        {
            imageBase64,
            language: options.language,
            subjectId: options.subjectId,
        },
        { timeout: options.timeout }
    );
    return { imageBase64, parsed };
}

export interface RunMultiAnalyzeOptions extends AnalyzeSingleOptions {
    concurrency?: number;
    onUpdate?: (items: MultiAnalyzeItem[]) => void;
}

/**
 * 并发调度多题识别（默认并发 2，对齐组卷页生成策略）。
 * 单题失败不中断整批，标记 failed 由用户在结果面板重试。
 */
export async function runMultiAnalyze(
    blobs: Blob[],
    options: RunMultiAnalyzeOptions
): Promise<MultiAnalyzeItem[]> {
    const concurrency = options.concurrency ?? 2;
    const items: MultiAnalyzeItem[] = blobs.map((_, i) => ({
        index: i + 1,
        status: "pending",
    }));
    const notify = () => options.onUpdate?.(items.map((item) => ({ ...item })));

    notify();

    let cursor = 0;
    const worker = async () => {
        while (cursor < blobs.length) {
            const i = cursor++;
            items[i] = { ...items[i], status: "analyzing" };
            notify();
            try {
                const { imageBase64, parsed } = await analyzeSingleBlob(blobs[i], options);
                items[i] = { ...items[i], status: "success", imageBase64, parsed };
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                items[i] = { ...items[i], status: "failed", error: message };
            }
            notify();
        }
    };

    const workers = Array.from({ length: Math.min(concurrency, blobs.length) }, () => worker());
    await Promise.all(workers);
    return items.map((item) => ({ ...item }));
}
