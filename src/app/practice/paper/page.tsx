"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, FileText, Trash2, Printer } from "lucide-react";
import Link from "next/link";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";

interface PaperListItem {
    id: string;
    title: string;
    mode: string;
    status: string;
    totalScore: number;
    createdAt: string;
    questionCount: number;
    gradedCount: number;
}

type PaperMode = "original" | "variant" | "mixed";

function PaperWizardContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { t } = useLanguage();

    const [notebooks, setNotebooks] = useState<Array<{ id: string; name: string }>>([]);
    const [subjectId, setSubjectId] = useState<string>(searchParams.get("subjectId") || "all");
    const [count, setCount] = useState(10);
    const [mode, setMode] = useState<PaperMode>("mixed");
    const [variantRatio, setVariantRatio] = useState(50);
    const [variantCount, setVariantCount] = useState(1);
    const [difficulty, setDifficulty] = useState("medium");
    const [generating, setGenerating] = useState(false);
    const [papers, setPapers] = useState<PaperListItem[]>([]);

    const loadPapers = () => {
        apiClient.get<PaperListItem[]>("/api/practice/paper/list")
            .then(setPapers)
            .catch(() => { /* 静默 */ });
    };

    useEffect(() => {
        apiClient.get<Array<{ id: string; name: string }>>("/api/notebooks")
            .then(setNotebooks)
            .catch(() => { /* 静默 */ });
        loadPapers();
    }, []);

    const generate = async () => {
        if (generating) return;
        setGenerating(true);
        try {
            const result = await apiClient.post<{ id: string; degradedCount: number }>("/api/practice/paper", {
                subjectId: subjectId === "all" ? undefined : subjectId,
                count,
                mode,
                variantRatio: variantRatio / 100,
                variantCount,
                difficulty,
            }, { timeout: 600000 });
            router.push(`/practice/paper/${result.id}`);
        } catch (error) {
            console.error(error);
            alert((error as { data?: { message?: string } })?.data?.message || "组卷失败，请检查 AI 配置后重试");
        } finally {
            setGenerating(false);
        }
    };

    const deletePaper = async (id: string) => {
        if (!confirm("确定删除这份试卷？")) return;
        try {
            await apiClient.delete(`/api/practice/paper/${id}`);
            loadPapers();
        } catch {
            alert("删除失败");
        }
    };

    return (
        <div className="container mx-auto px-4 py-8 max-w-3xl space-y-6">
            <h1 className="text-2xl font-bold flex items-center gap-2">
                <FileText className="h-6 w-6" />
                {t.paper?.title || "智能组卷"}
            </h1>

            <Card>
                <CardHeader><CardTitle>{t.paper?.newPaper || "创建试卷"}</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                            <label className="text-sm text-muted-foreground">{t.notebooks?.title || "错题本"}</label>
                            <Select value={subjectId} onValueChange={setSubjectId}>
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">{t.stats?.weakness?.allSubjects || "全部学科"}</SelectItem>
                                    {notebooks.map((n) => (
                                        <SelectItem key={n.id} value={n.id}>{n.name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm text-muted-foreground">{t.paper?.count || "选题数量"}</label>
                            <Input type="number" min={1} max={30} value={count} onChange={(e) => setCount(Math.min(30, Math.max(1, Number(e.target.value) || 1)))} />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm text-muted-foreground">{t.paper?.mode || "组卷模式"}</label>
                        <div className="grid grid-cols-3 gap-2">
                            {([
                                { key: "original", label: t.paper?.modeOriginal || "纯原题" },
                                { key: "mixed", label: t.paper?.modeMixed || "混合（推荐）" },
                                { key: "variant", label: t.paper?.modeVariant || "纯变式" },
                            ] as Array<{ key: PaperMode; label: string }>).map((m) => (
                                <button
                                    key={m.key}
                                    type="button"
                                    onClick={() => setMode(m.key)}
                                    className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                                        mode === m.key ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-accent"
                                    }`}
                                >
                                    {m.label}
                                </button>
                            ))}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t.paper?.modeHint || "选题自动按薄弱知识点加权排序（AI 建议选题），生成后仍可在试卷中调整"}
                        </p>
                    </div>

                    {mode === "mixed" && (
                        <div className="space-y-2">
                            <label className="text-sm text-muted-foreground">
                                {t.paper?.variantRatio || "变式比例"}：{100 - variantRatio}% : {variantRatio}%
                            </label>
                            <input
                                type="range" min={30} max={70} step={10} value={variantRatio}
                                onChange={(e) => setVariantRatio(Number(e.target.value))}
                                className="w-full"
                            />
                        </div>
                    )}

                    {mode === "variant" && (
                        <div className="space-y-2">
                            <label className="text-sm text-muted-foreground">{t.paper?.variantCount || "每题变式数"}</label>
                            <Select value={String(variantCount)} onValueChange={(v) => setVariantCount(Number(v))}>
                                <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {[1, 2, 3].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                                </SelectContent>
                            </Select>
                            {variantCount > 1 && (
                                <p className="text-xs text-amber-600">{t.paper?.variantCountHint || "变式数 &gt; 1 适合精选少量错题强化训练"}</p>
                            )}
                        </div>
                    )}

                    <div className="space-y-2">
                        <label className="text-sm text-muted-foreground">{t.practice?.difficulty?.label || "难度"}</label>
                        <Select value={difficulty} onValueChange={setDifficulty}>
                            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="easy">{t.practice?.difficulty?.easy || "简单"}</SelectItem>
                                <SelectItem value="medium">{t.practice?.difficulty?.medium || "中等"}</SelectItem>
                                <SelectItem value="hard">{t.practice?.difficulty?.hard || "困难"}</SelectItem>
                                <SelectItem value="harder">{t.practice?.difficulty?.harder || "挑战"}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <Button onClick={generate} disabled={generating} className="w-full">
                        {generating ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                {t.paper?.generating || "正在生成（约 1~2 分钟，请勿关闭页面）…"}
                            </>
                        ) : (
                            <>
                                <FileText className="mr-2 h-4 w-4" />
                                {t.paper?.generate || "生成试卷"}
                            </>
                        )}
                    </Button>
                </CardContent>
            </Card>

            <Card>
                <CardHeader><CardTitle>{t.paper?.myPapers || "我的试卷"}</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                    {papers.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-4 text-center">{t.paper?.noPapers || "还没有试卷，先创建一份吧"}</p>
                    ) : (
                        papers.map((p) => (
                            <div key={p.id} className="flex items-center gap-3 rounded-lg border p-3 text-sm">
                                <Link href={`/practice/paper/${p.id}`} className="flex-1 min-w-0">
                                    <div className="font-medium truncate">{p.title}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {p.questionCount} 题 · {p.totalScore} 分 · {p.status === "graded" ? `${t.paper?.graded || "已录成绩"}（${p.gradedCount}/${p.questionCount}）` : (t.paper?.ready || "待作答")}
                                    </div>
                                </Link>
                                <Button variant="ghost" size="sm" asChild>
                                    <Link href={`/practice/paper/${p.id}`}><Printer className="h-4 w-4" /></Link>
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => deletePaper(p.id)}>
                                    <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                            </div>
                        ))
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

export default function PaperWizardPage() {
    return (
        <Suspense fallback={
            <div className="flex justify-center p-8">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        }>
            <PaperWizardContent />
        </Suspense>
    );
}
