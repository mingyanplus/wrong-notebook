"use client";

import { useMemo } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QUESTION_TYPES, getCategoriesForSubject, ErrorCategoryCode } from "@/lib/error-categories";
import { useLanguage } from "@/contexts/LanguageContext";

interface ErrorCategoryPickerProps {
    /** 学科名（用于过滤可用错因，如"数学"/"英语"） */
    subjectName?: string | null;
    /** 主错因 code 或 "unknown" */
    errorCategory: string;
    secondaryErrorCategories: string[];
    questionType: string;
    onChange: (next: { errorCategory: string; secondaryErrorCategories: string[]; questionType: string }) => void;
}

/**
 * 错因/题型选择器（主错因 + 次错因 chips 上限 2 + 题型）
 * correction-editor 与错题详情页共用；次错因上限与"主错因互斥"规则在此单一实现。
 */
export function ErrorCategoryPicker({ subjectName, errorCategory, secondaryErrorCategories, questionType, onChange }: ErrorCategoryPickerProps) {
    const { t } = useLanguage();

    const availableCategories = useMemo(
        () => getCategoriesForSubject(subjectName),
        [subjectName]
    );

    return (
        <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                    <Label>{t.editor.questionType || "题型"}</Label>
                    <Select
                        value={questionType || "solve"}
                        onValueChange={(val) => onChange({ errorCategory, secondaryErrorCategories, questionType: val })}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {QUESTION_TYPES.map((qt) => (
                                <SelectItem key={qt.code} value={qt.code}>{qt.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="space-y-2">
                    <Label>{t.editor.errorCategory || "主要错因"}</Label>
                    <Select
                        value={errorCategory || "unknown"}
                        onValueChange={(val) =>
                            onChange({
                                errorCategory: val,
                                // 主错因变化时，从次错因中移除同项
                                secondaryErrorCategories: secondaryErrorCategories.filter((c) => c !== val),
                                questionType,
                            })
                        }
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="unknown">{t.editor.errorCategoryUnknown || "未判定"}</SelectItem>
                            {availableCategories.map((c) => (
                                <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>
            {errorCategory && errorCategory !== "unknown" && (
                <div className="space-y-2">
                    <Label>{t.editor.secondaryErrorCategories || "次要错因（最多 2 个）"}</Label>
                    <div className="flex flex-wrap gap-2">
                        {availableCategories
                            .filter((c) => c.code !== errorCategory)
                            .map((c) => {
                                const selected = secondaryErrorCategories.includes(c.code);
                                return (
                                    <button
                                        key={c.code}
                                        type="button"
                                        onClick={() => {
                                            const next = selected
                                                ? secondaryErrorCategories.filter((x) => x !== c.code)
                                                : [...secondaryErrorCategories, c.code as ErrorCategoryCode].slice(0, 2);
                                            onChange({ errorCategory, secondaryErrorCategories: next, questionType });
                                        }}
                                        className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                                            selected
                                                ? "border-primary bg-primary text-primary-foreground"
                                                : "border-input bg-background hover:bg-accent"
                                        }`}
                                    >
                                        {c.label}
                                    </button>
                                );
                            })}
                    </div>
                </div>
            )}
        </>
    );
}
