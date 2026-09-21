"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { ERROR_CATEGORIES } from "@/lib/error-categories";
import { isSameReviewSettings, DEFAULT_REVIEW_SETTINGS, UNCATEGORIZED_SENTINEL } from "@/lib/review-settings";
import { MAX_DAILY_LIMIT } from "@/lib/review-settings";
import type { ReviewSettings } from "@/lib/review-settings";

const LIMIT_OPTIONS: Array<number | null> = [null, 5, 10, 15, 20, 30, 50, 100, 200, MAX_DAILY_LIMIT];

/** 设置弹窗「通用」页内的复习设置：每日数量上限 + 重点错因勾选（作用于到期复习列表） */
export function ReviewSettingsSection() {
    const { t } = useLanguage();
    const [settings, setSettings] = useState<ReviewSettings>(DEFAULT_REVIEW_SETTINGS);
    const [baseline, setBaseline] = useState<ReviewSettings>(DEFAULT_REVIEW_SETTINGS);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        apiClient
            .get<ReviewSettings>("/api/review/settings")
            .then((s) => {
                setSettings(s);
                setBaseline(s);
            })
            .catch(() => {})
            .finally(() => setLoading(false));
    }, []);

    const toggleCategory = (code: string) => {
        setSettings((s) => {
            const cur = s.errorCategories ?? [];
            const next = cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code];
            return { ...s, errorCategories: next };
        });
        setSaved(false);
    };

    const save = async () => {
        setSaving(true);
        try {
            const result = await apiClient.put<ReviewSettings, ReviewSettings>("/api/review/settings", settings);
            setSettings(result);
            setBaseline(result);
            setSaved(true);
        } catch {
            alert(t.common?.error || "保存失败");
        } finally {
            setSaving(false);
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
                <Label>{t.settings?.general?.review?.title || "每日复习设置"}</Label>
                <p className="text-xs text-muted-foreground">
                    {t.settings?.general?.review?.desc || "到期复习列表按此过滤与限量，优先复习掌握度低的题"}
                </p>
            </div>

            <div className="space-y-2">
                <Label>{t.settings?.general?.review?.dailyLimit || "每日复习数量"}</Label>
                <Select
                    value={settings.dailyLimit === null ? "none" : String(settings.dailyLimit)}
                    onValueChange={(v) => {
                        setSettings((s) => ({ ...s, dailyLimit: v === "none" ? null : Number(v) }));
                        setSaved(false);
                    }}
                >
                    <SelectTrigger className="w-32">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {LIMIT_OPTIONS.map((n) => (
                            <SelectItem key={n === null ? "none" : String(n)} value={n === null ? "none" : String(n)}>
                                {n === null ? (t.settings?.general?.review?.noLimit || "不限") : String(n)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            <div className="space-y-2">
                <Label>{t.settings?.general?.review?.categories || "重点复习错因（不勾选 = 不过滤）"}</Label>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                    {ERROR_CATEGORIES.map((c) => {
                        const checked = (settings.errorCategories ?? []).includes(c.code);
                        return (
                            <label
                                key={c.code}
                                className="flex items-center gap-1.5 rounded border bg-background px-2 py-1.5 text-xs cursor-pointer hover:border-primary/50"
                                title={c.criteria}
                            >
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleCategory(c.code)}
                                    className="rounded border-gray-300 text-primary focus:ring-primary"
                                />
                                {c.label}
                            </label>
                        );
                    })}
                    {/* 未分类：没录错因的题也纳入复习（如做不来但当时没标错因的存量题） */}
                    <label
                        className="flex items-center gap-1.5 rounded border bg-background px-2 py-1.5 text-xs cursor-pointer hover:border-primary/50"
                        title={t.settings?.general?.review?.uncategorizedHint || "包含当时没有标注错因的题目（建议配合「批量补全」补齐错因）"}
                    >
                        <input
                            type="checkbox"
                            checked={(settings.errorCategories ?? []).includes(UNCATEGORIZED_SENTINEL)}
                            onChange={() => toggleCategory(UNCATEGORIZED_SENTINEL)}
                            className="rounded border-gray-300 text-primary focus:ring-primary"
                        />
                        {t.settings?.general?.review?.uncategorized || "未分类"}
                    </label>
                </div>
            </div>

            <Button type="button" size="sm" onClick={save} disabled={saving || isSameReviewSettings(settings, baseline)}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {saved
                    ? (t.settings?.general?.review?.saved || "已保存")
                    : (t.settings?.general?.review?.save || "保存复习设置")}
            </Button>
        </div>
    );
}
