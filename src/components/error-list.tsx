"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Search, Filter, CheckCircle, Clock, ChevronDown, Printer, ListChecks, Trash2, X, Bell, WandSparkles, FileText, Camera, PenLine } from "lucide-react";
import Link from "next/link";
import { format } from "date-fns";
import { processImageFile } from "@/lib/image-utils";
import { groupByFirstTag } from "@/lib/knowledge-tags";
import { useLanguage } from "@/contexts/LanguageContext";
import { useRouter } from "next/navigation";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KnowledgeFilter } from "@/components/knowledge-filter";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ERROR_CATEGORIES, getErrorCategory } from "@/lib/error-categories";
import { ErrorItem, PaginatedResponse, DueReviewItem } from "@/types/api";
import { apiClient } from "@/lib/api-client";
import { cleanMarkdown } from "@/lib/markdown-utils";
import { Pagination } from "@/components/ui/pagination";
import { DEFAULT_PAGE_SIZE } from "@/lib/constants/pagination";
import { getMistakeStatusLabel } from "@/lib/mistake-status";
import { DUE_SORT_MODES, type DueSortMode } from "@/lib/review-settings";

interface ErrorListProps {
    subjectId?: string;
    subjectName?: string;
}

type KnowledgeFilterChange = {
    gradeSemester?: string;
    chapter?: string;
    tag?: string | null;
};

// --- 列表偏好持久化：记住用户的筛选/排序/搜索/页码浏览习惯（按错题本分开存，避免互相污染）---
type SortOrder = "desc" | "asc";

interface ErrorListPrefs {
    search: string;
    masteryFilter: "all" | "mastered" | "unmastered";
    timeFilter: "all" | "week" | "month";
    gradeFilter: string;
    chapterFilter: string;
    paperLevelFilter: "all" | "a" | "b" | "other";
    errorCategoryFilters: string[];
    sourceFilter: string;
    selectedTag: string | null;
    sortOrder: SortOrder;
    dueSortOrder: DueSortMode;
    page: number;
}

const DEFAULT_PREFS: ErrorListPrefs = {
    search: "",
    masteryFilter: "unmastered",
    timeFilter: "all",
    gradeFilter: "",
    chapterFilter: "",
    paperLevelFilter: "all",
    errorCategoryFilters: [],
    sourceFilter: "all",
    selectedTag: null,
    sortOrder: "desc",
    dueSortOrder: "asc",
    page: 1,
};

/** 枚举型偏好字段的合法值表（其余字段按类型兜底） */
const PREF_ENUMS = {
    masteryFilter: ["all", "mastered", "unmastered"],
    timeFilter: ["all", "week", "month"],
    paperLevelFilter: ["all", "a", "b", "other"],
    sortOrder: ["desc", "asc"],
    dueSortOrder: DUE_SORT_MODES,
} as const;

function getPrefsKey(subjectId?: string): string {
    return `error-list-prefs:${subjectId || "all"}`;
}

function readPrefs(subjectId?: string): ErrorListPrefs {
    if (typeof window === "undefined") return DEFAULT_PREFS;
    try {
        const raw = window.localStorage.getItem(getPrefsKey(subjectId));
        if (!raw) return DEFAULT_PREFS;
        // 旧版单选字段 errorCategoryFilter（"all"|"code"）一并带出，供下方迁移
        const parsed = JSON.parse(raw) as Partial<ErrorListPrefs> & { errorCategoryFilter?: unknown };
        const p = { ...DEFAULT_PREFS, ...parsed } as ErrorListPrefs;
        // 逐字段兜底：写入方是本组件自身，脏数据只可能来自旧版本残留
        for (const key of Object.keys(PREF_ENUMS) as (keyof typeof PREF_ENUMS)[]) {
            if (!(PREF_ENUMS[key] as readonly string[]).includes(p[key])) {
                // 联合 key 的索引写入会被 TS 收窄为 never，经 Record 断言绕过（各枚举字段均为 string 字面量联合）
                (p as Record<typeof key, string>)[key] = DEFAULT_PREFS[key];
            }
        }
        for (const key of ["search", "gradeFilter", "chapterFilter"] as const) {
            if (typeof p[key] !== "string") p[key] = "";
        }
        if (typeof p.sourceFilter !== "string") p.sourceFilter = "all";
        // 错因多选：非法值过滤；旧版单选值迁移（非 "all" 的旧选择保留为单元素数组）
        const validCats = new Set<string>([...ERROR_CATEGORIES.map((c) => c.code as string), "unknown"]);
        if (!Array.isArray(p.errorCategoryFilters)) {
            const legacy = parsed.errorCategoryFilter;
            p.errorCategoryFilters = typeof legacy === "string" && validCats.has(legacy) ? [legacy] : [];
        } else {
            p.errorCategoryFilters = p.errorCategoryFilters.filter((c) => validCats.has(c));
        }
        if (typeof p.selectedTag !== "string") p.selectedTag = null;
        if (!Number.isInteger(p.page) || p.page < 1) p.page = 1;
        return p;
    } catch {
        return DEFAULT_PREFS;
    }
}

/** 筛选键 = 除 page 外的全部偏好字段（page 变化不算筛选变化，不触发页码重置） */
const FILTER_KEYS: (keyof Omit<ErrorListPrefs, "page">)[] = [
    "search", "masteryFilter", "timeFilter", "selectedTag", "gradeFilter",
    "chapterFilter", "paperLevelFilter", "errorCategoryFilters", "sourceFilter", "sortOrder",
];

export function ErrorList({ subjectId, subjectName }: ErrorListProps = {}) {
    const [items, setItems] = useState<ErrorItem[]>([]);
    const [, setLoading] = useState(true);
    // 浏览偏好：单个 state 对象（lazy init 读 localStorage，SSR/无存储回落默认值），切换错题本时由下方 effect 原子恢复
    const [prefs, setPrefs] = useState<ErrorListPrefs>(() => readPrefs(subjectId));
    const updatePrefs = (patch: Partial<ErrorListPrefs>) => setPrefs((p) => ({ ...p, ...patch }));
    const {
        search, masteryFilter, timeFilter, gradeFilter, chapterFilter,
        paperLevelFilter, errorCategoryFilters, sourceFilter, selectedTag, sortOrder, dueSortOrder, page,
    } = prefs;
    const [isBackfilling, setIsBackfilling] = useState(false);
    const [availableSources, setAvailableSources] = useState<string[]>([]);
    const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());
    // 到期待复习（艾宾浩斯计划）；knowledgeTags 供按知识点分组现做（用户流程：按知识点×错因过重点题）
    const [dueReviews, setDueReviews] = useState<DueReviewItem[]>([]);
    const [showDueList, setShowDueList] = useState(false);
    // 分页状态（pageSize/total/totalPages 非偏好，page 在 prefs 内持久化）
    const [pageSize] = useState(DEFAULT_PAGE_SIZE);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(0);
    // 多选模式状态
    const [isSelectMode, setIsSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [isDeleting, setIsDeleting] = useState(false);
    const { t, language } = useLanguage();
    const router = useRouter();

    // 拉取到期待复习数量（艾宾浩斯计划）；排序模式随偏好走（后端确定性乱序）
    useEffect(() => {
        let cancelled = false;
        apiClient.get<{ count: number; items: DueReviewItem[] }>(
            "/api/review/due",
            { params: { ...(subjectId ? { subjectId } : {}), sort: dueSortOrder } }
        )
            .then((data) => {
                if (!cancelled) setDueReviews(data.items || []);
            })
            .catch(() => { /* 静默失败，不影响主列表 */ });
        return () => { cancelled = true; };
    }, [subjectId, dueSortOrder]);

    // 来源列表与排序/筛选无关，仅随错题本变化拉取一次
    useEffect(() => {
        let cancelled = false;
        apiClient.get<string[]>("/api/error-items/sources")
            .then((data) => {
                if (!cancelled) setAvailableSources(data || []);
            })
            .catch(() => { /* 静默失败 */ });
        return () => { cancelled = true; };
    }, [subjectId]);

    // 追踪上次的筛选上下文（用于判断是否需要重置页码；切换错题本时恢复逻辑会直接改写）
    const prevRef = useRef({ subjectId, prefs });

    // 切换错题本时（同组件实例复用、params 变化）原子恢复该本的浏览偏好。首次挂载已由 lazy init 完成，不重复处理。
    // skipFetchRef/skipSaveRef：恢复值要到下一轮渲染才生效，跳过随后那一轮的请求与写入，
    // 避免用旧本的筛选值请求新本、或把旧本的值写进新本的 key。
    const lastSubjectIdRef = useRef(subjectId);
    const skipFetchRef = useRef(false);
    const skipSaveRef = useRef(false);
    // 切本恢复完成后的那一轮强制拉取（恢复值与 prevRef 相同，会被下方"无实质变化"判断拦住）
    const forceFetchRef = useRef(false);
    // 是否已拉取过（首挂载必须拉取；prevRef 初始与当前值相等，不能靠它区分首轮）
    const didFetchRef = useRef(false);
    useEffect(() => {
        if (lastSubjectIdRef.current === subjectId) return;
        lastSubjectIdRef.current = subjectId;
        const next = readPrefs(subjectId);
        setPrefs(next);
        prevRef.current = { subjectId, prefs: next };
        skipFetchRef.current = true;
        skipSaveRef.current = true;
        forceFetchRef.current = true;
    }, [subjectId]);

    const handleExportPrint = () => {
        const params = new URLSearchParams();
        if (subjectId) params.append("subjectId", subjectId);
        if (search) params.append("query", search);
        if (masteryFilter !== "all") {
            params.append("mastery", masteryFilter === "mastered" ? "1" : "0");
        }
        if (timeFilter !== "all") {
            params.append("timeRange", timeFilter);
        }
        if (selectedTag) {
            params.append("tag", selectedTag);
        }
        if (gradeFilter) params.append("gradeSemester", gradeFilter);
        if (chapterFilter) params.append("chapter", chapterFilter); // 章节筛选
        if (paperLevelFilter !== "all") params.append("paperLevel", paperLevelFilter);
        if (errorCategoryFilters.length > 0) params.append("errorCategory", errorCategoryFilters.join(","));
        if (sourceFilter !== "all") params.append("source", sourceFilter);

        router.push(`/print-preview?${params.toString()}`);
    };

    const handleTagClick = (tag: string) => {
        updatePrefs({ selectedTag: selectedTag === tag ? null : tag });
    };

    const handleFilterChange = ({ gradeSemester, chapter, tag }: KnowledgeFilterChange) => {
        setPrefs((p) => {
            const next = { ...p };
            if (gradeSemester !== undefined) next.gradeFilter = gradeSemester;
            if (chapter !== undefined) next.chapterFilter = chapter;
            // 注意：tag 可能是 undefined（表示清除），用 null 作为清除标识
            next.selectedTag = tag === undefined ? null : tag;

            // Clear dependent filters and reset page
            if (!gradeSemester) {
                next.gradeFilter = "";
                next.chapterFilter = "";
                next.selectedTag = null;
            } else if (!chapter) {
                next.chapterFilter = "";
            }
            next.page = 1; // 筛选变化时重置页码
            return next;
        });
    };

    // 使用服务端 items 直接渲染，章节过滤已在 KnowledgeFilter 中通过 tag 实现
    const filteredItems = items;

    const toggleTagsExpanded = (itemId: string, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setExpandedTags(prev => {
            const newSet = new Set(prev);
            if (newSet.has(itemId)) {
                newSet.delete(itemId);
            } else {
                newSet.add(itemId);
            }
            return newSet;
        });
    };

    // 多选模式相关函数
    const toggleSelectMode = () => {
        setIsSelectMode(!isSelectMode);
        setSelectedIds(new Set());
    };

    const toggleSelectItem = (id: string, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(id)) {
                newSet.delete(id);
            } else {
                newSet.add(id);
            }
            return newSet;
        });
    };

    const handleBatchDelete = async () => {
        if (selectedIds.size === 0) return;

        const confirmMsg = (t.notebook?.confirmBatchDelete || "Delete {count} items?")
            .replace("{count}", selectedIds.size.toString());
        if (!confirm(confirmMsg)) return;

        setIsDeleting(true);
        try {
            await apiClient.post("/api/error-items/batch-delete", {
                ids: Array.from(selectedIds),
            });
            alert(t.notebook?.batchDeleteSuccess || "Deleted successfully");
            setIsSelectMode(false);
            setSelectedIds(new Set());
            fetchItems();
        } catch (error) {
            console.error(error);
            alert(t.common?.messages?.deleteFailed || "Delete failed");
        } finally {
            setIsDeleting(false);
        }
    };

    useEffect(() => {
        // 切换错题本后恢复偏好的那一轮：旧 prefs 值不可信，跳过本次请求，等恢复值生效后再拉取
        if (skipFetchRef.current) {
            skipFetchRef.current = false;
            return;
        }

        const prev = prevRef.current;
        const filtersChanged =
            prev.subjectId !== subjectId ||
            FILTER_KEYS.some((k) => prev.prefs[k] !== prefs[k]);
        const pageChanged = prev.prefs.page !== prefs.page;

        // 更新 ref
        prevRef.current = { subjectId, prefs };

        if (forceFetchRef.current) {
            forceFetchRef.current = false;
        } else if (didFetchRef.current && !filtersChanged && !pageChanged) {
            // 仅到期排序等不影响主列表查询的偏好变化：不重拉
            return;
        }
        didFetchRef.current = true;

        if (filtersChanged && prefs.page !== 1) {
            // 筛选条件变化且不在第一页，重置到第一页（会再次触发此 effect）
            setPrefs((p) => ({ ...p, page: 1 }));
            return;
        }

        // 正常请求数据
        fetchItems();
    }, [subjectId, prefs]);

    // 偏好持久化：筛选/排序/搜索/页码变化时写入 localStorage（按错题本分开存），
    // 重新进入列表（含点进详情后返回）时由 lazy init 自动恢复
    useEffect(() => {
        if (skipSaveRef.current) {
            skipSaveRef.current = false;
            return;
        }
        try {
            window.localStorage.setItem(getPrefsKey(subjectId), JSON.stringify(prefs));
        } catch { /* 忽略隐私模式等写入失败 */ }
    }, [subjectId, prefs]);

    const fetchItems = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (subjectId) params.append("subjectId", subjectId);
            if (search) params.append("query", search);
            if (masteryFilter !== "all") {
                params.append("mastery", masteryFilter === "mastered" ? "1" : "0");
            }
            if (timeFilter !== "all") {
                params.append("timeRange", timeFilter);
            }
            if (selectedTag) {
                params.append("tag", selectedTag);
            }
            if (gradeFilter) params.append("gradeSemester", gradeFilter);
            if (chapterFilter) params.append("chapter", chapterFilter); // 章节筛选
            if (paperLevelFilter !== "all") params.append("paperLevel", paperLevelFilter);
            if (errorCategoryFilters.length > 0) params.append("errorCategory", errorCategoryFilters.join(","));
            if (sourceFilter !== "all") params.append("source", sourceFilter);
            // 排序：最新在前 / 最早在前
            params.append("sortOrder", sortOrder);
            // 分页参数
            params.append("page", page.toString());
            params.append("pageSize", pageSize.toString());

            const response = await apiClient.get<PaginatedResponse<ErrorItem>>(`/api/error-items/list?${params.toString()}`);
            setItems(response.items);
            setTotal(response.total);
            setTotalPages(response.totalPages);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    // 到期题按知识点分组（仅「知识点」排序模式；取首个标签，无标签归「未分类」）——支撑「按知识点逐块现做」的复习流程
    const dueGroups = useMemo(
        () =>
            dueSortOrder === "tag"
                ? Array.from(
                      groupByFirstTag(dueReviews, (d) => d.errorItem.knowledgeTags, t.filter.dueUngrouped || "未分类").entries()
                  )
                : [],
        [dueReviews, dueSortOrder, t.filter.dueUngrouped]
    );

    // 单题忙碌集合（录入中/批改中统一互斥）
    const [busy, setBusy] = useState<Set<string>>(new Set());
    const markBusy = (id: string) => setBusy((s) => new Set(s).add(id));
    const clearBusy = (id: string) =>
        setBusy((s) => {
            const next = new Set(s);
            next.delete(id);
            return next;
        });
    // 拍照批改的共享文件选择器
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const gradingTargetRef = useRef<string | null>(null);

    // 纸质复习卷结果录入：逐题对/错 → 完成复习计划 + 掌握度流转 + 艾宾浩斯下一条（录入后从到期列表移除）
    const recordReview = async (errorItemId: string, isCorrect: boolean) => {
        markBusy(errorItemId);
        try {
            await apiClient.post("/api/review/complete", { results: [{ errorItemId, isCorrect }] });
            setDueReviews((list) => list.filter((d) => d.errorItem.id !== errorItemId));
        } catch {
            alert(t.filter?.recordFail || "录入失败，请重试");
        } finally {
            clearBusy(errorItemId);
        }
    };

    // 批改公共流程（拍照/手动共用）：调 AI 批改 → 展示点评 → 家长确认后录入
    const runGrade = async (errorItemId: string, payload: { imageBase64?: string; studentAnswer?: string }) => {
        markBusy(errorItemId);
        try {
            const result = await apiClient.post<
                { isCorrect: boolean; comment: string },
                { errorItemId: string; imageBase64?: string; studentAnswer?: string }
            >("/api/review/grade", { errorItemId, ...payload });
            const verdict = result.isCorrect
                ? t.filter?.gradeCorrect || "✓ 做对"
                : t.filter?.gradeWrong || "✗ 做错";
            const ok = window.confirm(
                `${verdict}\n\n${result.comment}\n\n${t.filter?.gradeConfirm || "按此结果录入吗？（取消 = 不录入）"}`
            );
            if (ok) await recordReview(errorItemId, result.isCorrect);
        } catch {
            alert(t.filter?.gradeFail || "批改失败，请重试");
        } finally {
            clearBusy(errorItemId);
        }
    };

    // 到期条目行（「知识点」分组与平铺两种渲染共用）
    const renderDueRow = (d: DueReviewItem) => (
        <div
            key={d.errorItem.id}
            className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-amber-100/60 dark:hover:bg-amber-900/40"
        >
            <Link
                href={`/error-items/${d.errorItem.id}`}
                className="flex-1 truncate text-amber-900 dark:text-amber-200"
            >
                {cleanMarkdown(d.errorItem.questionText || "").slice(0, 60) || "（无题干）"}
            </Link>
            {d.overdueDays > 0 && (
                <span className="shrink-0 text-xs text-amber-700 dark:text-amber-300">
                    {(t.filter.dueOverdueDays || "overdue {days}d").replace("{days}", String(d.overdueDays))}
                </span>
            )}
            <span className="flex shrink-0 items-center gap-1">
                <button
                    type="button"
                    disabled={busy.has(d.errorItem.id)}
                    onClick={() => startPhotoGrading(d.errorItem.id)}
                    title={t.filter?.gradePhoto || "拍照批改：AI 对照参考答案点评"}
                    className="flex h-6 w-6 items-center justify-center rounded-full border border-amber-600/70 text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-40 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/40"
                >
                    {busy.has(d.errorItem.id) ? (
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-600 border-t-transparent" />
                    ) : (
                        <Camera className="h-3 w-3" />
                    )}
                </button>
                <button
                    type="button"
                    disabled={busy.has(d.errorItem.id)}
                    onClick={() => startManualGrading(d.errorItem.id)}
                    title={t.filter?.manualGrade || "手动输入答案批改：识别不佳时的兜底"}
                    className="flex h-6 w-6 items-center justify-center rounded-full border border-amber-600/70 text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-40 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/40"
                >
                    <PenLine className="h-3 w-3" />
                </button>
                <button
                    type="button"
                    disabled={busy.has(d.errorItem.id)}
                    onClick={() => recordReview(d.errorItem.id, true)}
                    title={t.filter?.recordCorrect || "做对，推进复习计划"}
                    className="rounded-full border border-green-600/70 px-2 py-0.5 text-xs text-green-700 transition-colors hover:bg-green-50 disabled:opacity-40 dark:border-green-700 dark:text-green-400 dark:hover:bg-green-950/40"
                >
                    ✓
                </button>
                <button
                    type="button"
                    disabled={busy.has(d.errorItem.id)}
                    onClick={() => recordReview(d.errorItem.id, false)}
                    title={t.filter?.recordWrong || "做错，重置掌握度并重新安排复习"}
                    className="rounded-full border border-red-600/70 px-2 py-0.5 text-xs text-red-700 transition-colors hover:bg-red-50 disabled:opacity-40 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                    ✗
                </button>
            </span>
        </div>
    );

    // 拍照批改：读图压缩（复用全站上传链路的压缩）→ AI 批改
    const handleGradeFile = (file: File) => {
        const errorItemId = gradingTargetRef.current;
        if (!errorItemId) return;
        processImageFile(file)
            .then((imageBase64) => runGrade(errorItemId, { imageBase64 }))
            .catch(() => alert(t.filter?.gradeFail || "批改失败，请重试"));
    };

    // 手动输入作答批改（拍照识别不佳时的兜底）：输入孩子作答文字 → AI 对照参考答案批改
    const startManualGrading = (errorItemId: string) => {
        const studentAnswer = window.prompt(
            t.filter?.manualGradePrompt || "请输入孩子的作答（最终答案或简要过程），AI 将对照参考答案批改点评："
        );
        if (studentAnswer === null || !studentAnswer.trim()) return;
        void runGrade(errorItemId, { studentAnswer: studentAnswer.trim() });
    };

    const startPhotoGrading = (errorItemId: string) => {
        gradingTargetRef.current = errorItemId;
        fileInputRef.current?.click();
    };

    // 错因多选切换（再次点击取消勾选）
    const toggleErrorCategory = (code: string) =>
        updatePrefs({
            errorCategoryFilters: errorCategoryFilters.includes(code)
                ? errorCategoryFilters.filter((c) => c !== code)
                : [...errorCategoryFilters, code],
        });
    // 到期排序四档文案（查表，避免嵌套三元）
    const dueSortLabels: Record<DueSortMode, string> = {
        asc: t.filter?.dueSortAsc || "Sequential",
        desc: t.filter?.dueSortDesc || "Reversed",
        random: t.filter?.dueSortRandom || "Shuffled",
        tag: t.filter?.dueSortTag || "By Topic",
    };
    // 错因筛选触发按钮文案：0 项=全部 / 1 项=该项标签 / 多项=计数
    const errorCategoryLabel =
        errorCategoryFilters.length === 0
            ? t.filter.errorCategory || "全部错因"
            : errorCategoryFilters.length === 1
                ? errorCategoryFilters[0] === "unknown"
                    ? t.filter.errorCategoryUnknown || "未分类"
                    : getErrorCategory(errorCategoryFilters[0])?.label ?? errorCategoryFilters[0]
                : (t.filter?.errorCategorySelected || "已选 {n} 项").replace("{n}", String(errorCategoryFilters.length));

    return (
        <div className="space-y-6">
            {/* 拍照批改的共享文件选择器 */}
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = ""; // 允许重复选择同一文件
                    if (f) handleGradeFile(f);
                }}
            />
            {dueReviews.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950">
                    <div className="flex items-center">
                        <button
                            type="button"
                            className="flex flex-1 items-center gap-2 px-4 py-3 text-left text-sm font-medium text-amber-900 dark:text-amber-200"
                            onClick={() => setShowDueList((v) => !v)}
                        >
                            <Bell className="h-4 w-4" />
                            <span>
                                {t.filter.dueBanner || "Due for review today"}：{dueReviews.length} {t.filter.dueItems || ""}
                            </span>
                        </button>
                        <button
                            type="button"
                            className="mr-2 flex shrink-0 items-center gap-1 rounded-md border border-amber-300 bg-white/70 px-2.5 py-1.5 text-xs font-medium text-amber-900 transition-colors hover:bg-white dark:border-amber-800 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-900/40"
                            onClick={() => {
                                // 打印卷跟随到期排序偏好（选乱序则卷面同序；打印页透传 sort 给 /api/review/due）
                                const params = new URLSearchParams();
                                if (subjectId) params.set("subjectId", subjectId);
                                params.set("sort", dueSortOrder);
                                router.push(`/review/print?${params.toString()}`);
                            }}
                        >
                            <Printer className="h-3.5 w-3.5" />
                            {t.filter?.printDue || "打印复习卷"}
                        </button>
                        <button
                            type="button"
                            className="mr-3 flex h-6 w-6 shrink-0 items-center justify-center text-amber-900 dark:text-amber-200"
                            onClick={() => setShowDueList((v) => !v)}
                            aria-label="toggle"
                        >
                            <ChevronDown
                                className={`h-4 w-4 transition-transform ${showDueList ? "rotate-180" : ""}`}
                            />
                        </button>
                    </div>
                    {showDueList && (
                        <div className="divide-y divide-amber-100 border-t border-amber-200 dark:divide-amber-900 dark:border-amber-900">
                            {/* 排序切换：随浏览偏好持久化（下次进入保持上次选择） */}
                            <div className="flex items-center gap-2 px-4 py-2 text-xs">
                                <span className="text-amber-800 dark:text-amber-300">{t.filter?.dueSortLabel || "Order"}</span>
                                <span className="flex items-center gap-1">
                                    {DUE_SORT_MODES.map((mode) => (
                                        <button
                                            key={mode}
                                            type="button"
                                            onClick={() => updatePrefs({ dueSortOrder: mode })}
                                            className={`rounded-md px-2 py-1 ${
                                                dueSortOrder === mode
                                                    ? "bg-amber-200 font-medium text-amber-900 dark:bg-amber-800 dark:text-amber-100"
                                                    : "text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/40"
                                            }`}
                                        >
                                            {dueSortLabels[mode]}
                                        </button>
                                    ))}
                                </span>
                            </div>
                            {dueSortOrder === "tag"
                                ? dueGroups.map(([tag, groupItems]) => (
                                      <div key={tag}>
                                          <div className="bg-amber-100/60 px-4 py-1.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                                              {tag} · {groupItems.length}
                                          </div>
                                          {groupItems.map(renderDueRow)}
                                      </div>
                                  ))
                                : dueReviews.map(renderDueRow)}
                        </div>
                    )}
                </div>
            )}
            <div className="flex flex-col sm:flex-row gap-4">
                <div className="relative w-full sm:flex-1">
                    <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder={t.notebook.search}
                        className="pl-9"
                        value={search}
                        onChange={(e) => updatePrefs({ search: e.target.value })}
                    />
                </div>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline">
                            <Filter className="mr-2 h-4 w-4" />
                            {t.notebook.filter}
                            <ChevronDown className="ml-2 h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuLabel>{t.filter.masteryStatus || "Mastery Status"}</DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => updatePrefs({ masteryFilter: "all" })}>
                            {masteryFilter === "all" && "✓ "}{t.filter.all || "All"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => updatePrefs({ masteryFilter: "unmastered" })}>
                            {masteryFilter === "unmastered" && "✓ "}{t.filter.review || "To Review"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => updatePrefs({ masteryFilter: "mastered" })}>
                            {masteryFilter === "mastered" && "✓ "}{t.filter.mastered || "Mastered"}
                        </DropdownMenuItem>

                        <DropdownMenuSeparator />

                        <DropdownMenuLabel>{t.filter.timeRange || "Time Range"}</DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => updatePrefs({ timeFilter: "all" })}>
                            {timeFilter === "all" && "✓ "}{t.filter.allTime || "All Time"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => updatePrefs({ timeFilter: "week" })}>
                            {timeFilter === "week" && "✓ "}{t.filter.lastWeek || "Last Week"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => updatePrefs({ timeFilter: "month" })}>
                            {timeFilter === "month" && "✓ "}{t.filter.lastMonth || "Last Month"}
                        </DropdownMenuItem>

                        <DropdownMenuSeparator />

                        <DropdownMenuLabel>{t.filter.sortOrder || "Sort Order"}</DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => updatePrefs({ sortOrder: "desc" })}>
                            {sortOrder === "desc" && "✓ "}{t.filter.sortDesc || "Newest First"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => updatePrefs({ sortOrder: "asc" })}>
                            {sortOrder === "asc" && "✓ "}{t.filter.sortAsc || "Oldest First"}
                        </DropdownMenuItem>
                        {sortOrder === "asc" && (
                            <DropdownMenuItem onClick={() => updatePrefs({ sortOrder: "desc" })}>
                                {t.filter.sortReset || "Reset to Default (Newest First)"}
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="outline" onClick={handleExportPrint}>
                    <Printer className="mr-2 h-4 w-4" />
                    {t.notebook?.exportPrint || "导出打印"}
                </Button>
                <Button variant="outline" onClick={() => router.push(`/practice/paper${subjectId ? `?subjectId=${subjectId}` : ""}`)}>
                    <FileText className="mr-2 h-4 w-4" />
                    {t.paper?.title || "智能组卷"}
                </Button>
                <Button
                    variant={isSelectMode ? "secondary" : "outline"}
                    onClick={toggleSelectMode}
                >
                    <ListChecks className="mr-2 h-4 w-4" />
                    {isSelectMode ? (t.notebook?.cancelSelect || "取消") : (t.notebook?.selectMode || "多选")}
                </Button>
            </div>

            {/* Advanced Filters Row */}
            <div className="flex flex-col sm:flex-row gap-4 items-stretch sm:items-center">
                <div className="w-full sm:w-auto">
                    <KnowledgeFilter
                        gradeSemester={gradeFilter}
                        tag={selectedTag}
                        onFilterChange={handleFilterChange}
                        subjectName={subjectName}
                    />
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button
                        variant={paperLevelFilter === "all" ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => updatePrefs({ paperLevelFilter: "all" })}
                    >
                        {t.filter.all || "All"}
                    </Button>
                    <Button
                        variant={paperLevelFilter === "a" ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => updatePrefs({ paperLevelFilter: "a" })}
                    >
                        {t.editor.paperLevels?.a || "Paper A"}
                    </Button>
                    <Button
                        variant={paperLevelFilter === "b" ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => updatePrefs({ paperLevelFilter: "b" })}
                    >
                        {t.editor.paperLevels?.b || "Paper B"}
                    </Button>
                    <Button
                        variant={paperLevelFilter === "other" ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => updatePrefs({ paperLevelFilter: "other" })}
                    >
                        {t.editor.paperLevels?.other || "Other"}
                    </Button>
                    {/* 错因多选：复选框项点击不关闭菜单，可连续勾选对比多类错因 */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" className="h-8 max-w-[180px]">
                                <span className="truncate">{errorCategoryLabel}</span>
                                <ChevronDown className="ml-1 h-3.5 w-3.5 shrink-0" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-44">
                            <DropdownMenuItem onClick={() => updatePrefs({ errorCategoryFilters: [] })}>
                                {errorCategoryFilters.length === 0 && "✓ "}{t.filter.errorCategory || "全部错因"}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuCheckboxItem
                                checked={errorCategoryFilters.includes("unknown")}
                                onCheckedChange={() => toggleErrorCategory("unknown")}
                                onSelect={(e) => e.preventDefault()}
                            >
                                {t.filter.errorCategoryUnknown || "未分类"}
                            </DropdownMenuCheckboxItem>
                            {ERROR_CATEGORIES.map((c) => (
                                <DropdownMenuCheckboxItem
                                    key={c.code}
                                    checked={errorCategoryFilters.includes(c.code)}
                                    onCheckedChange={() => toggleErrorCategory(c.code)}
                                    onSelect={(e) => e.preventDefault()}
                                >
                                    {c.label}
                                </DropdownMenuCheckboxItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={isBackfilling}
                        onClick={async () => {
                            if (isBackfilling) return;
                            if (!confirm(t.filter.backfillConfirm || "将使用 AI 为缺少错因/题型/标签的错题批量补全（每次最多 20 题），继续？")) return;
                            setIsBackfilling(true);
                            try {
                                const result = await apiClient.post<{ processed: number; updated: number; failedCount: number }>("/api/error-items/backfill", {}, { timeout: 600000 });
                                alert((t.filter.backfillDone || "补全完成：处理 {n} 题，更新 {u} 题")
                                    .replace("{n}", String(result.processed))
                                    .replace("{u}", String(result.updated)));
                                fetchItems();
                            } catch (err) {
                                console.error(err);
                                alert(t.filter.backfillFailed || "批量补全失败");
                            } finally {
                                setIsBackfilling(false);
                            }
                        }}
                        title={t.filter.backfill || "批量补全"}
                    >
                        <WandSparkles className={`h-4 w-4 ${isBackfilling ? "animate-pulse" : ""}`} />
                        <span className="hidden sm:inline">{isBackfilling ? (t.filter.backfillRunning || "补全中…") : (t.filter.backfill || "批量补全")}</span>
                    </Button>
                    {availableSources.length > 0 && (
                        <Select value={sourceFilter} onValueChange={(val) => updatePrefs({ sourceFilter: val })}>
                            <SelectTrigger className="h-8 w-[150px]">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">{t.filter.sourcePaper || "全部来源"}</SelectItem>
                                {availableSources.map((s) => (
                                    <SelectItem key={s} value={s}>{s}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    )}
                </div>
            </div>

            {selectedTag && (
                <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
                    <span className="text-sm text-muted-foreground">
                        {t.filter.filteringByTag || "Filtering by tag"}:
                    </span>
                    <Badge variant="secondary" className="cursor-pointer" onClick={() => updatePrefs({ selectedTag: null })}>
                        {selectedTag}
                        <span className="ml-1 text-xs">×</span>
                    </Badge>
                </div>
            )}

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {filteredItems.map((item) => {
                    // 优先使用 tags 关联，回退到 knowledgePoints
                    let tags: string[] = [];
                    if (item.tags && item.tags.length > 0) {
                        tags = item.tags.map((tag) => tag.name);
                    } else {
                        try {
                            tags = JSON.parse(item.knowledgePoints || "[]");
                        } catch {
                            tags = [];
                        }
                    }
                    return (
                        <div key={item.id} className="relative">
                            {/* 选择模式下的复选框 */}
                            {isSelectMode && (
                                <div
                                    className="absolute top-2 left-2 z-10"
                                    onClick={(e) => toggleSelectItem(item.id, e)}
                                >
                                    <Checkbox
                                        checked={selectedIds.has(item.id)}
                                        className="h-5 w-5 border-2 bg-background shadow-sm"
                                    />
                                </div>
                            )}
                            <Link href={isSelectMode ? "#" : `/error-items/${item.id}`} onClick={(e) => isSelectMode && e.preventDefault()}>
                                <Card className="h-full hover:border-primary/50 transition-colors cursor-pointer gap-2 pt-4">
                                    <CardHeader className="pb-0">
                                        <div className="flex justify-between items-start">
                                            <Badge
                                                variant={item.masteryLevel > 0 ? "default" : "secondary"}
                                                className={item.masteryLevel > 0 ? "bg-green-600 hover:bg-green-700" : ""}
                                            >
                                                {item.masteryLevel > 0 ? (
                                                    <span className="flex items-center gap-1">
                                                        <CheckCircle className="h-3 w-3" /> {t.notebook.mastered}
                                                    </span>
                                                ) : (
                                                    <span className="flex items-center gap-1">
                                                        <Clock className="h-3 w-3" /> {t.notebook.review}
                                                    </span>
                                                )}
                                            </Badge>
                                            <span className="text-xs text-muted-foreground">
                                                {format(new Date(item.createdAt), "MM/dd")}
                                            </span>
                                        </div>
                                    </CardHeader>
                                    <CardContent>
                                        <div className="text-sm line-clamp-3">
                                            {(() => {
                                                // 提取文本并清理 LaTeX/Markdown 格式
                                                const rawText = (item.questionText || "").split('\n\n')[0]; // 取第一段
                                                const cleanText = cleanMarkdown(rawText);

                                                return cleanText.length > 80
                                                    ? cleanText.substring(0, 80) + "..."
                                                    : cleanText;
                                            })()}
                                        </div>
                                        <div className="flex flex-wrap gap-2 mt-3">
                                            <Badge variant={item.mistakeStatus === "wrong_attempt" ? "default" : "secondary"} className="text-xs">
                                                {getMistakeStatusLabel(item.mistakeStatus, language)}
                                            </Badge>
                                        </div>
                                        <div className="flex flex-wrap gap-2 mt-3">
                                            {(expandedTags.has(item.id) ? tags : tags.slice(0, 3)).map((tag: string) => (
                                                <Badge
                                                    key={tag}
                                                    variant={selectedTag === tag ? "default" : "outline"}
                                                    className="text-xs cursor-pointer hover:bg-primary/10 transition-colors"
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        handleTagClick(tag);
                                                    }}
                                                >
                                                    {tag}
                                                </Badge>
                                            ))}
                                            {tags.length > 3 && (
                                                <Badge
                                                    variant="secondary"
                                                    className="text-xs cursor-pointer hover:bg-secondary/80 transition-colors"
                                                    title={expandedTags.has(item.id)
                                                        ? (t.notebooks?.collapseTagsTooltip || "Click to collapse")
                                                        : (t.notebooks?.expandTagsTooltip || "Click to expand {count} tags").replace("{count}", (tags.length - 3).toString())}
                                                    onClick={(e) => toggleTagsExpanded(item.id, e)}
                                                >
                                                    {expandedTags.has(item.id) ? (
                                                        <>{t.notebooks?.collapseTags || "Collapse"}</>
                                                    ) : (
                                                        <>{(t.notebooks?.expandTags || "+{count} more").replace("{count}", (tags.length - 3).toString())}</>
                                                    )}
                                                </Badge>
                                            )}
                                        </div>
                                    </CardContent>
                                </Card>
                            </Link>
                        </div>
                    );
                })}
            </div>

            {/* 分页器 */}
            <Pagination
                page={page}
                totalPages={totalPages}
                total={total}
                pageSize={pageSize}
                onPageChange={(page) => updatePrefs({ page })}
            />

            {/* 多选模式底部操作栏 */}
            {isSelectMode && (
                <div className="fixed bottom-0 left-0 right-0 bg-background border-t shadow-lg p-4 z-50">
                    <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
                        <span className="text-sm text-muted-foreground">
                            {(t.notebook?.selectedCount || "{count} selected").replace("{count}", selectedIds.size.toString())}
                        </span>
                        <div className="flex gap-2">
                            <Button
                                variant="outline"
                                onClick={toggleSelectMode}
                            >
                                <X className="mr-2 h-4 w-4" />
                                {t.notebook?.cancelSelect || "取消"}
                            </Button>
                            <Button
                                variant="destructive"
                                onClick={handleBatchDelete}
                                disabled={selectedIds.size === 0 || isDeleting}
                            >
                                <Trash2 className="mr-2 h-4 w-4" />
                                {t.notebook?.deleteSelected || "删除选中"}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
