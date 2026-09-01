"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Flame } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { getErrorCategoryLabel } from "@/lib/error-categories";

interface WeaknessResponse {
    availableSubjects: string[];
    availableSemesters: string[];
    totalItems: number;
    ranking: Array<{
        tagId: string;
        tagName: string;
        score: number;
        itemCount: number;
        reviewCount: number;
        correctRate: number | null;
        topCategory: string | null;
    }>;
    heatmap: {
        tags: string[];
        categories: Array<{ code: string; label: string }>;
        cells: number[][];
    };
}

export function WeaknessStats() {
    const [data, setData] = useState<WeaknessResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [subject, setSubject] = useState<string>("all");
    const [semester, setSemester] = useState<string>("all");
    const { t } = useLanguage();

    const fetchReport = useCallback(async (subj: string, sem: string) => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (subj !== "all") params.append("subject", subj);
            if (sem !== "all") params.append("semester", sem);
            const result = await apiClient.get<WeaknessResponse>(`/api/stats/weakness?${params.toString()}`);
            setData(result);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchReport(subject, semester);
    }, [subject, semester, fetchReport]);

    const maxCell = Math.max(1, ...(data?.heatmap.cells.flat() ?? [0]));

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Select value={subject} onValueChange={setSubject}>
                    <SelectTrigger className="w-[160px]">
                        <SelectValue placeholder={t.stats?.weakness?.allSubjects || "全部学科"} />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">{t.stats?.weakness?.allSubjects || "全部学科"}</SelectItem>
                        {(data?.availableSubjects ?? []).map((s) => (
                            <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Select value={semester} onValueChange={setSemester}>
                    <SelectTrigger className="w-[180px]">
                        <SelectValue placeholder={t.stats?.weakness?.allSemesters || "全部学期"} />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">{t.stats?.weakness?.allSemesters || "全部学期"}</SelectItem>
                        {(data?.availableSemesters ?? []).map((s) => (
                            <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            {loading ? (
                <div className="flex justify-center p-8">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                </div>
            ) : !data || data.ranking.length === 0 ? (
                <Card>
                    <CardContent className="py-8 text-center text-muted-foreground">
                        {t.stats?.weakness?.empty || "暂无数据：给错题标注错因后即可看到薄弱知识点分析"}
                    </CardContent>
                </Card>
            ) : (
                <>
                    {/* TOP 薄弱知识点 */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Flame className="h-5 w-5 text-orange-500" />
                                {t.stats?.weakness?.rankingTitle || "薄弱知识点 TOP 10"}
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-2">
                                {data.ranking.slice(0, 10).map((r, i) => (
                                    <div key={r.tagId} className="flex items-center gap-3 text-sm">
                                        <span className={`w-6 text-right font-bold ${i < 3 ? "text-orange-500" : "text-muted-foreground"}`}>
                                            {i + 1}
                                        </span>
                                        <span className="flex-1 truncate font-medium">{r.tagName}</span>
                                        {r.topCategory && (
                                            <span className="hidden sm:inline text-xs text-muted-foreground">
                                                {t.stats?.weakness?.mainCategory || "主要错因"}：{getErrorCategoryLabel(r.topCategory)}
                                            </span>
                                        )}
                                        <span className="text-xs text-muted-foreground">{r.itemCount} 题</span>
                                        {r.correctRate !== null && (
                                            <span className={`text-xs ${r.correctRate >= 0.7 ? "text-green-600" : "text-red-500"}`}>
                                                {Math.round(r.correctRate * 100)}%
                                            </span>
                                        )}
                                        <span className="w-14 text-right font-bold text-orange-600 dark:text-orange-400">
                                            {r.score.toFixed(1)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    </Card>

                    {/* 知识点 × 错因 热力图 */}
                    <Card>
                        <CardHeader>
                            <CardTitle>{t.stats?.weakness?.heatmapTitle || "知识点 × 错因 热力图"}</CardTitle>
                        </CardHeader>
                        <CardContent className="overflow-x-auto">
                            <table className="w-full min-w-[640px] border-collapse text-xs">
                                <thead>
                                    <tr>
                                        <th className="sticky left-0 bg-background px-2 py-1 text-left font-medium">
                                            {t.stats?.weakness?.knowledgePoint || "知识点"}
                                        </th>
                                        {data.heatmap.categories.map((c) => (
                                            <th key={c.code} className="px-1 py-1 font-medium whitespace-nowrap">{c.label}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.heatmap.tags.map((tagName, ti) => (
                                        <tr key={tagName} className="border-t">
                                            <td className="sticky left-0 bg-background px-2 py-1.5 whitespace-nowrap font-medium">{tagName}</td>
                                            {data.heatmap.categories.map((c, ci) => {
                                                const v = data.heatmap.cells[ti]?.[ci] ?? 0;
                                                const intensity = v / maxCell;
                                                return (
                                                    <td key={c.code} className="px-1 py-1.5 text-center">
                                                        <span
                                                            className="inline-block min-w-8 rounded px-1.5 py-0.5"
                                                            style={{
                                                                backgroundColor: v > 0 ? `rgba(249, 115, 22, ${0.15 + intensity * 0.75})` : undefined,
                                                                color: intensity > 0.55 ? "white" : undefined,
                                                            }}
                                                        >
                                                            {v > 0 ? (Number.isInteger(v) ? v : v.toFixed(1)) : ""}
                                                        </span>
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </CardContent>
                    </Card>
                </>
            )}
        </div>
    );
}
