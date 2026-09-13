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
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KnowledgeFilter } from "@/components/knowledge-filter";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ERROR_CATEGORIES } from "@/lib/error-categories";
import { ErrorItem, PaginatedResponse } from "@/types/api";
import { apiClient } from "@/lib/api-client";
import { cleanMarkdown } from "@/lib/markdown-utils";
import { Pagination } from "@/components/ui/pagination";
import { DEFAULT_PAGE_SIZE } from "@/lib/constants/pagination";
import { getMistakeStatusLabel } from "@/lib/mistake-status";

interface ErrorListProps {
    subjectId?: string;
    subjectName?: string;
}

type KnowledgeFilterChange = {
    gradeSemester?: string;
    chapter?: string;
    tag?: string | null;
};

export function ErrorList({ subjectId, subjectName }: ErrorListProps = {}) {
    const [items, setItems] = useState<ErrorItem[]>([]);
    const [, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [masteryFilter, setMasteryFilter] = useState<"all" | "mastered" | "unmastered">("unmastered");
    const [timeFilter, setTimeFilter] = useState<"all" | "week" | "month">("all");
    const [gradeFilter, setGradeFilter] = useState("");
    const [chapterFilter, setChapterFilter] = useState("");
    const [paperLevelFilter, setPaperLevelFilter] = useState<"all" | "a" | "b" | "other">("all");
    const [errorCategoryFilter, setErrorCategoryFilter] = useState<string>("all");
    const [isBackfilling, setIsBackfilling] = useState(false);
    const [sourceFilter, setSourceFilter] = useState<string>("all");
    const [availableSources, setAvailableSources] = useState<string[]>([]);
    const [selectedTag, setSelectedTag] = useState<string | null>(null);
    const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());
    // 到期待复习（艾宾浩斯计划）；knowledgeTags 供按知识点分组现做（用户流程：按知识点×错因过重点题）
    const [dueReviews, setDueReviews] = useState<Array<{ overdueDays: number; errorItem: { id: string; questionText: string | null; knowledgeTags?: string[] } }>>([]);
    const [showDueList, setShowDueList] = useState(false);
    // 分页状态
    const [page, setPage] = useState(1);
    const [pageSize] = useState(DEFAULT_PAGE_SIZE);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(0);
    // 多选模式状态
    const [isSelectMode, setIsSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [isDeleting, setIsDeleting] = useState(false);
    const { t, language } = useLanguage();
    const router = useRouter();

    // 拉取到期待复习数量（艾宾浩斯计划）
    useEffect(() => {
        let cancelled = false;
        const query = subjectId ? `?subjectId=${subjectId}` : "";
        apiClient.get<{ count: number; items: Array<{ overdueDays: number; errorItem: { id: string; questionText: string | null; knowledgeTags?: string[] } }> }>(`/api/review/due${query}`)
            .then((data) => {
                if (!cancelled) setDueReviews(data.items || []);
            })
            .catch(() => { /* 静默失败，不影响主列表 */ });
        apiClient.get<string[]>("/api/error-items/sources")
            .then((data) => {
                if (!cancelled) setAvailableSources(data || []);
            })
            .catch(() => { /* 静默失败 */ });
        return () => { cancelled = true; };
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
        if (errorCategoryFilter !== "all") params.append("errorCategory", errorCategoryFilter);
        if (sourceFilter !== "all") params.append("source", sourceFilter);

        router.push(`/print-preview?${params.toString()}`);
    };

    const handleTagClick = (tag: string) => {
        setSelectedTag(selectedTag === tag ? null : tag);
    };

    const handleFilterChange = ({ gradeSemester, chapter, tag }: KnowledgeFilterChange) => {
        if (gradeSemester !== undefined) setGradeFilter(gradeSemester);
        if (chapter !== undefined) setChapterFilter(chapter);
        // 注意：tag 可能是 undefined（表示清除），需要用 'tag' in obj 来判断是否传入了该参数
        // 但由于我们的结构是直接解构，这里改用 null 作为清除标识
        // 实际上 KnowledgeFilter 传入的是 { tag: undefined }，所以 tag 参数确实会被设置
        // 问题在于 !== undefined 不能区分"未传入"和"传入undefined"
        // 正确的做法是检查参数对象中是否有该 key
        setSelectedTag(tag === undefined ? null : tag);

        // Clear dependent filters and reset page
        if (!gradeSemester) {
            setGradeFilter("");
            setChapterFilter("");
            setSelectedTag(null);
        } else if (!chapter) {
            setChapterFilter("");
        }
        setPage(1); // 筛选变化时重置页码
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

    // 追踪筛选条件是否变化（用于判断是否需要重置页码）
    const prevFiltersRef = useRef({ search, masteryFilter, timeFilter, selectedTag, subjectId, gradeFilter, chapterFilter, paperLevelFilter, errorCategoryFilter, sourceFilter });

    useEffect(() => {
        const prevFilters = prevFiltersRef.current;
        const filtersChanged =
            prevFilters.search !== search ||
            prevFilters.masteryFilter !== masteryFilter ||
            prevFilters.timeFilter !== timeFilter ||
            prevFilters.selectedTag !== selectedTag ||
            prevFilters.subjectId !== subjectId ||
            prevFilters.gradeFilter !== gradeFilter ||
            prevFilters.chapterFilter !== chapterFilter ||
            prevFilters.paperLevelFilter !== paperLevelFilter ||
            prevFilters.errorCategoryFilter !== errorCategoryFilter ||
            prevFilters.sourceFilter !== sourceFilter;

        // 更新 ref
        prevFiltersRef.current = { search, masteryFilter, timeFilter, selectedTag, subjectId, gradeFilter, chapterFilter, paperLevelFilter, errorCategoryFilter, sourceFilter };

        if (filtersChanged && page !== 1) {
            // 筛选条件变化且不在第一页，重置到第一页（会再次触发此 effect）
            setPage(1);
            return;
        }

        // 正常请求数据
        fetchItems();
    }, [page, search, masteryFilter, timeFilter, selectedTag, subjectId, gradeFilter, chapterFilter, paperLevelFilter, errorCategoryFilter, sourceFilter]);

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
            if (errorCategoryFilter !== "all") params.append("errorCategory", errorCategoryFilter);
            if (sourceFilter !== "all") params.append("source", sourceFilter);
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

    // 到期题按知识点分组（取首个标签，无标签归「未分类」）——支撑「按知识点逐块现做」的复习流程
    const dueGroups = useMemo(
        () =>
            Array.from(
                groupByFirstTag(dueReviews, (d) => d.errorItem.knowledgeTags, t.filter.dueUngrouped || "未分类").entries()
            ),
        [dueReviews, t.filter.dueUngrouped]
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
                            onClick={() =>
                                router.push(`/review/print${subjectId ? `?subjectId=${subjectId}` : ""}`)
                            }
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
                            {dueGroups.map(([tag, items]) => (
                                <div key={tag}>
                                    <div className="bg-amber-100/60 px-4 py-1.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                                        {tag} · {items.length}
                                    </div>
                                    {items.map((d) => (
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
                                    ))}
                                </div>
                            ))}
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
                        onChange={(e) => setSearch(e.target.value)}
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
                        <DropdownMenuItem onClick={() => setMasteryFilter("all")}>
                            {masteryFilter === "all" && "✓ "}{t.filter.all || "All"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setMasteryFilter("unmastered")}>
                            {masteryFilter === "unmastered" && "✓ "}{t.filter.review || "To Review"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setMasteryFilter("mastered")}>
                            {masteryFilter === "mastered" && "✓ "}{t.filter.mastered || "Mastered"}
                        </DropdownMenuItem>

                        <DropdownMenuSeparator />

                        <DropdownMenuLabel>{t.filter.timeRange || "Time Range"}</DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => setTimeFilter("all")}>
                            {timeFilter === "all" && "✓ "}{t.filter.allTime || "All Time"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setTimeFilter("week")}>
                            {timeFilter === "week" && "✓ "}{t.filter.lastWeek || "Last Week"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setTimeFilter("month")}>
                            {timeFilter === "month" && "✓ "}{t.filter.lastMonth || "Last Month"}
                        </DropdownMenuItem>
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
                        onClick={() => setPaperLevelFilter("all")}
                    >
                        {t.filter.all || "All"}
                    </Button>
                    <Button
                        variant={paperLevelFilter === "a" ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => setPaperLevelFilter("a")}
                    >
                        {t.editor.paperLevels?.a || "Paper A"}
                    </Button>
                    <Button
                        variant={paperLevelFilter === "b" ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => setPaperLevelFilter("b")}
                    >
                        {t.editor.paperLevels?.b || "Paper B"}
                    </Button>
                    <Button
                        variant={paperLevelFilter === "other" ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => setPaperLevelFilter("other")}
                    >
                        {t.editor.paperLevels?.other || "Other"}
                    </Button>
                    <Select
                        value={errorCategoryFilter}
                        onValueChange={(val) => setErrorCategoryFilter(val)}
                    >
                        <SelectTrigger className="h-8 w-[140px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">{t.filter.errorCategory || "全部错因"}</SelectItem>
                            <SelectItem value="unknown">{t.filter.errorCategoryUnknown || "未分类"}</SelectItem>
                            {ERROR_CATEGORIES.map((c) => (
                                <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
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
                        <Select value={sourceFilter} onValueChange={setSourceFilter}>
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
                    <Badge variant="secondary" className="cursor-pointer" onClick={() => setSelectedTag(null)}>
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
                onPageChange={setPage}
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
