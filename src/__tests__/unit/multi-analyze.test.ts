import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-client", () => ({
    apiClient: {
        post: vi.fn(),
    },
}));

vi.mock("@/lib/image-utils", () => ({
    processImageFile: vi.fn(),
}));

import { runMultiAnalyze } from "@/lib/multi-analyze";
import { apiClient } from "@/lib/api-client";
import { processImageFile } from "@/lib/image-utils";
import type { AnalyzeResponse } from "@/types/api";

const mockedPost = vi.mocked(apiClient.post);
const mockedProcess = vi.mocked(processImageFile);

const makeBlob = () => new Blob(["image-bytes"], { type: "image/jpeg" });

const makeParsed = (n: number): AnalyzeResponse =>
    ({
        questionText: `第${n}题`,
        answerText: "略",
        analysis: "略",
        knowledgePoints: ["函数"],
        wrongAnswerText: "",
        mistakeAnalysis: "",
        mistakeStatus: "unknown",
        subject: "数学",
        requiresImage: false,
    }) as unknown as AnalyzeResponse;

beforeEach(() => {
    vi.clearAllMocks();
    let counter = 0;
    mockedProcess.mockImplementation(async () => `data:image/jpeg;base64,img${++counter}`);
});

describe("runMultiAnalyze", () => {
    it("全部成功：逐题挂载 imageBase64 与 parsed，index 从 1 连续编号", async () => {
        mockedPost.mockImplementation(async (_url, body) => {
            // 透传压缩产物给 /api/analyze
            expect((body as { imageBase64?: string }).imageBase64).toMatch(/^data:image\/jpeg;base64,/);
            return makeParsed(1);
        });

        const results = await runMultiAnalyze([makeBlob(), makeBlob(), makeBlob()], {
            language: "zh",
            subjectId: "sub-1",
        });

        expect(results).toHaveLength(3);
        expect(results.map((r) => r.index)).toEqual([1, 2, 3]);
        expect(results.every((r) => r.status === "success")).toBe(true);
        results.forEach((r) => {
            expect(r.imageBase64).toMatch(/^data:image\/jpeg;base64,/);
            expect(r.parsed?.questionText).toBe("第1题");
        });
        expect(mockedPost).toHaveBeenCalledTimes(3);
        // 请求体携带学科与语言
        expect(mockedPost.mock.calls[0][1]).toMatchObject({ language: "zh", subjectId: "sub-1" });
    });

    it("单题失败不中断整批：失败项标记 error，其余成功", async () => {
        mockedPost.mockImplementation(async (_url, _body, opts) => {
            const { signal } = (opts ?? {}) as { signal?: AbortSignal };
            expect(signal).toBeUndefined();
            return makeParsed(1);
        });
        mockedPost.mockRejectedValueOnce(new Error("AI_CONNECTION_FAILED"));

        const results = await runMultiAnalyze([makeBlob(), makeBlob(), makeBlob()], { language: "zh" });

        expect(results.map((r) => r.status)).toEqual(["failed", "success", "success"]);
        expect(results[0].error).toBe("AI_CONNECTION_FAILED");
        expect(results[0].parsed).toBeUndefined();
        expect(results[1].parsed?.questionText).toBe("第1题");
    });

    it("空批次：直接返回空数组且不发请求", async () => {
        const results = await runMultiAnalyze([], { language: "zh" });
        expect(results).toEqual([]);
        expect(mockedPost).not.toHaveBeenCalled();
    });

    it("onUpdate 首次回调发出全量 pending，结束时为终态", async () => {
        mockedPost.mockResolvedValue(makeParsed(1));
        const onUpdate = vi.fn();

        const promise = runMultiAnalyze([makeBlob(), makeBlob()], { language: "zh", onUpdate });
        // 初始 pending 快照（同步发出）
        const first = onUpdate.mock.calls[0][0];
        expect(first.map((i: { status: string }) => i.status)).toEqual(["pending", "pending"]);

        const results = await promise;
        const last = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
        expect(last.map((i: { status: string }) => i.status)).toEqual(["success", "success"]);
        // 回调传入的是拷贝，不受内部后续变更影响
        expect(first[0]).not.toBe(results[0]);
    });

    it("并发限制为 2：同一时刻最多 2 个任务在识别", async () => {
        const resolvers: Array<(v: unknown) => void> = [];
        mockedPost.mockImplementation(
            () => new Promise((resolve) => { resolvers.push(resolve); })
        );
        const onUpdate = vi.fn();

        const promise = runMultiAnalyze(
            [makeBlob(), makeBlob(), makeBlob(), makeBlob()],
            { language: "zh", concurrency: 2, onUpdate }
        );

        // 前 2 个任务发出后，后 2 个排队等待
        await vi.waitFor(() => expect(resolvers.length).toBe(2));
        const analyzingCount = (items: Array<{ status: string }>) =>
            items.filter((i) => i.status === "analyzing").length;
        const snapshot = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
        expect(analyzingCount(snapshot)).toBe(2);

        // 释放前两个，后两个才发出
        resolvers.forEach((r) => r(makeParsed(1)));
        await vi.waitFor(() => expect(resolvers.length).toBe(4));
        resolvers.slice(2).forEach((r) => r(makeParsed(1)));

        const results = await promise;
        expect(results).toHaveLength(4);
        expect(results.every((i) => i.status === "success")).toBe(true);
    });
});
