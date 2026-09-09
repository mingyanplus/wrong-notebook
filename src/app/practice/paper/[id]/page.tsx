"use client";

import { useEffect, useState, useMemo } from "react";
import { flushSync } from "react-dom";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Loader2, Printer, ClipboardCheck, Trash2, Check, RotateCcw, ChevronDown, Eraser } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { QUESTION_TYPES } from "@/lib/error-categories";
import { ImageMaskEditor } from "@/components/practice/image-mask-editor";
import type { ImageMask } from "@/lib/image-masks";

interface PaperQuestion {
    id: string;
    order: number;
    section: string;
    questionType: string;
    score: number;
    isVariant: boolean;
    sourceErrorItemId: string | null;
    questionText: string;
    answerText: string;
    analysis: string;
    knowledgePoints: string | null;
    originalImageUrl: string | null;
    requiresImage: boolean | null; // 原题是否必须看图（null=未判断，打印智能模式保守显示）
    imageMasks: ImageMask[];       // 源错题的打印遮罩（白块覆盖手写痕迹）
    isCorrect: boolean | null;
}

interface PaperDetail {
    id: string;
    title: string;
    mode: string;
    status: string;
    totalScore: number;
    createdAt: string;
    questions: PaperQuestion[];
    subject?: { id: string; name: string } | null;
}

const CN_NUMERALS = ["一", "二", "三", "四", "五", "六"];
// 大题标题由 QUESTION_TYPES 顺序派生（选择 → 填空 → 判断 → 解答），与组卷排序单一来源
const SECTION_TITLES: Record<string, string> = Object.fromEntries(
    QUESTION_TYPES.map((t, i) => [t.code, `${CN_NUMERALS[i]}、${t.label}`])
);

export default function PaperDetailPage() {
    const params = useParams();
    const router = useRouter();
    const { t } = useLanguage();

    const [paper, setPaper] = useState<PaperDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [grading, setGrading] = useState(false);
    const [gradeInputs, setGradeInputs] = useState<Record<string, boolean>>({});
    const [saving, setSaving] = useState(false);
    // 打印时原图处理模式：smart=按 requiresImage 分流（防作答痕迹泄题）/ hide=全部隐藏 / show=全部显示
    const [imageMode, setImageMode] = useState<"smart" | "hide" | "show">("smart");
    const [maskEditing, setMaskEditing] = useState<PaperQuestion | null>(null);

    useEffect(() => {
        if (params.id) {
            apiClient.get<PaperDetail>(`/api/practice/paper/${params.id}`)
                .then(setPaper)
                .catch(() => router.push("/practice/paper"))
                .finally(() => setLoading(false));
        }
    }, [params.id, router]);

    const sections = useMemo(() => {
        if (!paper) return [];
        const map = new Map<string, PaperQuestion[]>();
        for (const q of paper.questions) {
            const list = map.get(q.section) ?? [];
            list.push(q);
            map.set(q.section, list);
        }
        return Array.from(map.entries());
    }, [paper]);

    // 智能模式下将隐藏原图的题数（菜单提示用）
    const smartHiddenCount = useMemo(
        () => (paper?.questions ?? []).filter((q) => q.originalImageUrl && !q.isVariant && q.requiresImage === false).length,
        [paper]
    );

    const printHideImage = (q: PaperQuestion): boolean => {
        if (imageMode === "hide") return true;
        if (imageMode === "show") return false;
        return q.requiresImage === false; // smart：仅明确判定"无需看图"才隐藏，null 保守显示
    };

    const print = (withAnswers: boolean, mode: "smart" | "hide" | "show") => {
        const el = document.getElementById("answer-section");
        if (el) el.style.display = withAnswers ? "block" : "none";
        // 图片显隐靠 className 生效，flushSync 确保 DOM 同步更新后再唤起打印
        flushSync(() => setImageMode(mode));
        window.print();
    };

    const startGrading = () => {
        if (!paper) return;
        const inputs: Record<string, boolean> = {};
        paper.questions.forEach((q) => {
            if (q.isCorrect !== null) inputs[q.id] = q.isCorrect;
        });
        setGradeInputs(inputs);
        setGrading(true);
    };

    const saveGrades = async () => {
        if (!paper) return;
        const results = Object.entries(gradeInputs).map(([questionId, isCorrect]) => ({ questionId, isCorrect }));
        if (results.length === 0) {
            alert("请先标记每道题的对错");
            return;
        }
        setSaving(true);
        try {
            await apiClient.post(`/api/practice/paper/${paper.id}/grade`, { results });
            alert("成绩已录入，掌握度与复习计划已更新");
            setGrading(false);
            const fresh = await apiClient.get<PaperDetail>(`/api/practice/paper/${paper.id}`);
            setPaper(fresh);
        } catch {
            alert("保存失败");
        } finally {
            setSaving(false);
        }
    };

    const deletePaper = async () => {
        if (!paper || !confirm("确定删除这份试卷？")) return;
        try {
            await apiClient.delete(`/api/practice/paper/${paper.id}`);
            router.push("/practice/paper");
        } catch {
            alert("删除失败");
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center p-16">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    if (!paper) return null;

    return (
        <div className="container mx-auto px-4 py-8 max-w-4xl">
            {/* 工具栏（打印时隐藏） */}
            <div className="print:hidden mb-6 flex flex-wrap items-center gap-2">
                <div className="flex-1 min-w-0">
                    <h1 className="text-2xl font-bold truncate">{paper.title}</h1>
                    <p className="text-sm text-muted-foreground mt-1">
                        {paper.questions.length} 题 · {paper.totalScore} 分 ·{" "}
                        {paper.status === "graded" ? (t.paper?.graded || "已录成绩") : (t.paper?.ready || "待作答")}
                    </p>
                </div>
                {grading ? (
                    <>
                        <Button onClick={saveGrades} disabled={saving}>
                            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                            {t.paper?.saveGrades || "保存成绩"}
                        </Button>
                        <Button variant="outline" onClick={() => setGrading(false)}>
                            <RotateCcw className="mr-2 h-4 w-4" />{t.common?.cancel || "取消"}
                        </Button>
                    </>
                ) : (
                    <>
                        <Button variant="outline" onClick={startGrading}>
                            <ClipboardCheck className="mr-2 h-4 w-4" />{t.paper?.recordGrades || "录成绩"}
                        </Button>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="outline">
                                    <Printer className="mr-2 h-4 w-4" />{t.paper?.printQuestions || "打印题目卷"}
                                    <ChevronDown className="ml-1 h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => print(false, "smart")}>
                                    智能模式{smartHiddenCount > 0 ? `（隐藏 ${smartHiddenCount} 题原图）` : ""}
                                    <span className="block text-xs text-muted-foreground">无需看图的题不打印原图，防止作答痕迹泄答案</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => print(false, "hide")}>
                                    隐藏全部原图
                                    <span className="block text-xs text-muted-foreground">纯文字重做，适合题干已完整转录的卷子</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => print(false, "show")}>
                                    显示全部原图
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Button variant="outline" onClick={() => print(true, "show")}>
                            <Printer className="mr-2 h-4 w-4" />{t.paper?.printWithAnswers || "打印（含答案）"}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={deletePaper}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                    </>
                )}
            </div>

            {/* 试卷头部（打印时显示，屏幕上隐藏——定案：不要姓名/日期/总分栏，仅标题） */}
            <div className="hidden print:block text-center mb-6">
                <h1 className="text-xl font-bold">{paper.title}</h1>
                <p className="text-sm mt-1">（共 {paper.questions.length} 题，{paper.totalScore} 分）</p>
            </div>

            {/* 题目区（按大题分组） */}
            <div className="space-y-6">
                {sections.map(([section, questions]) => (
                    <div key={section}>
                        <h2 className="font-bold text-lg mb-3 border-b pb-2">
                            {SECTION_TITLES[section] ?? section}（共 {questions.length} 题，{questions.reduce((s, q) => s + q.score, 0)} 分）
                        </h2>
                        <div className="space-y-5">
                            {questions.map((q) => (
                                <div key={q.id} className="flex gap-3 print:break-inside-avoid">
                                    <div className="shrink-0 text-sm font-medium pt-0.5 w-8">
                                        {q.order}.
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[11px] text-muted-foreground mb-1 print:hidden">
                                            {q.score} 分{q.isVariant ? ` · ${t.paper?.variantTag || "变式"}` : ""}
                                        </div>
                                        <div className="prose prose-sm max-w-none">
                                            <MarkdownRenderer content={q.questionText} />
                                        </div>
                                        {q.originalImageUrl && !q.isVariant && (
                                            <div className={`relative mt-2 inline-block ${printHideImage(q) ? "print:hidden" : ""}`}>
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img
                                                    src={q.originalImageUrl}
                                                    alt="原题"
                                                    className="block max-w-[45%] rounded border print:max-w-[55%]"
                                                />
                                                {/* 打印遮罩：白色覆盖原图上的手写痕迹（print-color-adjust 确保打印背景色生效） */}
                                                {q.imageMasks?.map((m, i) => (
                                                    <div
                                                        key={i}
                                                        className="absolute bg-white print:border-0"
                                                        style={{
                                                            left: `${m.x * 100}%`,
                                                            top: `${m.y * 100}%`,
                                                            width: `${m.w * 100}%`,
                                                            height: `${m.h * 100}%`,
                                                            printColorAdjust: "exact",
                                                            WebkitPrintColorAdjust: "exact",
                                                        }}
                                                    />
                                                ))}
                                            </div>
                                        )}
                                        {q.originalImageUrl && !q.isVariant && q.sourceErrorItemId && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="print:hidden mt-1 h-7 gap-1 px-2 text-xs text-muted-foreground"
                                                onClick={() => setMaskEditing(q)}
                                            >
                                                <Eraser className="h-3.5 w-3.5" />
                                                遮盖作答痕迹{q.imageMasks?.length ? `（${q.imageMasks.length}）` : ""}
                                            </Button>
                                        )}
                                        {grading && (
                                            <div className="mt-2 flex items-center gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => setGradeInputs((p) => ({ ...p, [q.id]: true }))}
                                                    className={`rounded-full border px-3 py-1 text-xs ${gradeInputs[q.id] === true ? "border-green-600 bg-green-600 text-white" : "border-input"}`}
                                                >
                                                    ✓ {t.paper?.correct || "对"}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setGradeInputs((p) => ({ ...p, [q.id]: false }))}
                                                    className={`rounded-full border px-3 py-1 text-xs ${gradeInputs[q.id] === false ? "border-red-600 bg-red-600 text-white" : "border-input"}`}
                                                >
                                                    ✗ {t.paper?.wrong || "错"}
                                                </button>
                                            </div>
                                        )}
                                        {!grading && q.isCorrect !== null && (
                                            <span className={`inline-block mt-2 rounded px-2 py-0.5 text-xs ${q.isCorrect ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                                                {q.isCorrect ? "✓" : "✗"}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>

            {/* 答案区：屏幕上折叠展示；打印时强制新起一页（print 函数控制显隐） */}
            <div
                id="answer-section"
                className="mt-10 print:block print:[break-before:page]"
                style={{ pageBreakBefore: "always" }}
            >
                <Card className="print:border-0 print:shadow-none">
                    <CardHeader className="print:hidden"><CardTitle>{t.paper?.answersSection || "参考答案与解析"}</CardTitle></CardHeader>
                    <CardContent className="space-y-4">
                        {paper.questions.map((q) => (
                            <div key={q.id} className="border-b pb-3 last:border-0">
                                <div className="text-sm font-medium mb-1">
                                    {q.order}. {q.score} 分
                                    {q.knowledgePoints ? (
                                        <span className="ml-2 text-xs text-muted-foreground font-normal">
                                            {(() => { try { return JSON.parse(q.knowledgePoints).join("、"); } catch { return ""; } })()}
                                        </span>
                                    ) : null}
                                </div>
                                <div className="prose prose-sm max-w-none"><MarkdownRenderer content={q.answerText} /></div>
                                <details className="mt-1 print:open">
                                    <summary className="text-xs text-muted-foreground cursor-pointer">{t.paper?.showAnalysis || "查看解析"}</summary>
                                    <div className="prose prose-sm max-w-none mt-1"><MarkdownRenderer content={q.analysis} /></div>
                                </details>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            </div>

            {/* 遮罩标注器：保存后本地更新对应题的遮罩（无需整卷刷新） */}
            {maskEditing && maskEditing.sourceErrorItemId && maskEditing.originalImageUrl && (
                <ImageMaskEditor
                    errorItemId={maskEditing.sourceErrorItemId}
                    imageUrl={maskEditing.originalImageUrl}
                    initialMasks={maskEditing.imageMasks ?? []}
                    open={!!maskEditing}
                    onOpenChange={(o) => { if (!o) setMaskEditing(null); }}
                    onSaved={(masks) => {
                        const targetId = maskEditing.id;
                        setPaper((p) => p && ({
                            ...p,
                            questions: p.questions.map((qq) => qq.id === targetId ? { ...qq, imageMasks: masks } : qq),
                        }));
                    }}
                />
            )}

        </div>
    );
}
