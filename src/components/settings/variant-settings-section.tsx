"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, WandSparkles } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { DIFFICULTY_LEVELS, DIFFICULTY_LABELS, DEFAULT_VARIANT_SETTINGS, serializeVariantSettings } from "@/lib/variant-settings";
import type { VariantSettings, VariantProgress } from "@/lib/variant-settings";

const COUNT_OPTIONS = [0, 1, 2, 3, 4, 5];

interface VariantStats {
    itemCount: number;
    variantCount: number;
    targetCount: number;
    enabled: boolean;
    /** 按难度分布（含已停用档位的历史存量），键为难度 code */
    byDifficulty?: Record<string, number>;
}

/** 设置弹窗「通用」页内的变式自动生成配置：开关 + 各难度数量 + 存量补齐 */
export function VariantSettingsSection() {
    const { t } = useLanguage();
    const [settings, setSettings] = useState<VariantSettings>(DEFAULT_VARIANT_SETTINGS);
    const [baseline, setBaseline] = useState(DEFAULT_VARIANT_SETTINGS);
    const [stats, setStats] = useState<VariantStats | null>(null);
    const [progress, setProgress] = useState<VariantProgress | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [backfilling, setBackfilling] = useState(false);

    /** 拉取配置与进度；statsOnly=true 供轮询使用——只更新统计，不回写 settings，避免覆盖用户正在编辑的表单 */
    const load = (statsOnly = false) =>
        apiClient
            .get<{ settings?: VariantSettings; stats: VariantStats; progress?: VariantProgress }>(`/api/variants/settings${statsOnly ? "?statsOnly=1" : ""}`)
            .then((d) => {
                if (!statsOnly && d.settings) {
                    setSettings(d.settings);
                    setBaseline(d.settings);
                }
                setStats(d.stats);
                if (d.progress) setProgress(d.progress);
            })
            .catch(() => {});

    useEffect(() => {
        load().finally(() => setLoading(false));
    }, []);

    // 后台生成存在缺口（服务端确认开启且未达标）或补齐轮次进行中时轮询进度，数字随后台入库实时变化；
    // 达标/完成或关闭弹窗后停止。
    const hasGap = stats !== null && stats.enabled && stats.variantCount < stats.targetCount;
    const generating = progress?.active === true;
    useEffect(() => {
        if (!hasGap && !generating) return;
        const timer = setInterval(() => load(true), 10000);
        return () => clearInterval(timer);
    }, [hasGap, generating]);

    const save = async () => {
        setSaving(true);
        try {
            const result = await apiClient.put<VariantSettings, VariantSettings>("/api/variants/settings", settings);
            setSettings(result);
            setBaseline(result);
            setSaved(true);
            load();
        } catch {
            alert(t.common?.error || "保存失败");
        } finally {
            setSaving(false);
        }
    };

    const backfill = async () => {
        if (
            !confirm(
                (t.settings?.general?.variant?.backfillConfirm ||
                    "将为现有错题在后台排队生成变式题（已够数的自动跳过）。AI 调用量可能较大，确认继续？")
            )
        ) {
            return;
        }
        setBackfilling(true);
        try {
            const result = await apiClient.post<{ queued: number }, Record<string, never>>("/api/variants/backfill", {});
            alert(
                (t.settings?.general?.variant?.backfillQueued || "已排队 {n} 道错题，正在后台生成…").replace(
                    "{n}",
                    String(result.queued)
                )
            );
            load();
        } catch {
            alert(t.settings?.general?.variant?.backfillDisabled || "请先开启自动生成并设置数量");
        } finally {
            setBackfilling(false);
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
            <div className="space-y-1">
                <Label>{t.settings?.general?.variant?.title || "举一反三自动生成"}</Label>
                <p className="text-xs text-muted-foreground">
                    {t.settings?.general?.variant?.desc || "开启后错题入库自动按下方数量生成变式题，打印复习卷时可直接勾选取用"}
                </p>
            </div>

            <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                    type="checkbox"
                    checked={settings.enabled}
                    onChange={(e) => {
                        setSettings((s) => ({ ...s, enabled: e.target.checked }));
                        setSaved(false);
                    }}
                    className="rounded border-gray-300 text-primary focus:ring-primary"
                />
                {t.settings?.general?.variant?.enable || "错题入库后自动生成"}
            </label>

            <div className="space-y-2">
                <Label>{t.settings?.general?.variant?.perDifficulty || "每题各难度生成数量"}</Label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {DIFFICULTY_LEVELS.map((level) => (
                        <div key={level} className="space-y-1">
                            <span className="text-xs text-muted-foreground">
                                {t.reviewPrint?.variantLevels?.[level] ?? DIFFICULTY_LABELS[level]}
                            </span>
                            <Select
                                value={String(settings.perDifficulty[level] ?? 0)}
                                onValueChange={(v) => {
                                    setSettings((s) => ({
                                        ...s,
                                        perDifficulty: { ...s.perDifficulty, [level]: Number(v) },
                                    }));
                                    setSaved(false);
                                }}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {COUNT_OPTIONS.map((n) => (
                                        <SelectItem key={n} value={String(n)}>
                                            {n === 0 ? (t.settings?.general?.variant?.none || "不生成") : `${n}`}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    ))}
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    size="sm"
                    onClick={save}
                    disabled={saving || serializeVariantSettings(settings) === serializeVariantSettings(baseline)}
                >
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {saved
                        ? (t.settings?.general?.variant?.saved || "已保存")
                        : (t.settings?.general?.variant?.save || "保存变式设置")}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={backfill} disabled={backfilling || !settings.enabled}>
                    {backfilling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <WandSparkles className="mr-2 h-4 w-4" />}
                    {t.settings?.general?.variant?.backfill || "为现有错题补齐"}
                </Button>
                {progress?.active && (
                    <span className="inline-flex items-center gap-1 text-xs text-primary">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {(t.settings?.general?.variant?.generating || "生成中 {done}/{total} 题")
                            .replace("{done}", String(progress.done))
                            .replace("{total}", String(progress.total))}
                    </span>
                )}
                {stats && (
                    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                        <span>
                            {(t.settings?.general?.variant?.progress || "已生成 {done} / 目标 {total}")
                                .replace("{done}", String(stats.variantCount))
                                .replace("{total}", String(stats.targetCount))}
                        </span>
                        {/* 按难度逐档展示（含已停用档位的历史存量）：开启档位显示 已有/目标，停用档位显示存量 */}
                        <span>
                            {DIFFICULTY_LEVELS.filter(
                                (lv) => (stats.byDifficulty?.[lv] ?? 0) > 0 || (settings.perDifficulty[lv] ?? 0) > 0
                            )
                                .map((lv) => {
                                    const have = stats.byDifficulty?.[lv] ?? 0;
                                    const perItem = settings.perDifficulty[lv] ?? 0;
                                    const label = t.reviewPrint?.variantLevels?.[lv] ?? DIFFICULTY_LABELS[lv];
                                    return perItem > 0
                                        ? `${label} ${have}/${perItem * stats.itemCount}`
                                        : `${label} ${have}${t.settings?.general?.variant?.levelOff || "（未启用）"}`;
                                })
                                .join(" · ")}
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}
