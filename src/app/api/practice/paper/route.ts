import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, badRequest } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getAIService } from "@/lib/ai";
import { QUESTION_TYPES, getErrorCategoryLabel } from "@/lib/error-categories";
import { categoryWeight, recencyFactor } from "@/lib/weakness";
import { WEAKNESS_CONFIG } from "@/lib/weakness-config";
import { buildPaperPlan } from "@/lib/paper-plan";
import type { Prisma } from "@prisma/client";

type ItemWithRels = Prisma.ErrorItemGetPayload<{ include: { tags: true; subject: true } }>;

const logger = createLogger('api:practice:paper');

const MAX_COUNT = 30;
const MAX_VARIANT_COUNT = 3;
const AI_RETRIES = 3; // 定案：单题失败自动重试 3 次
const CONCURRENCY = 2; // 定案：并发 2 路

interface GenerateBody {
    subjectId?: string;
    count?: number;
    mode?: "original" | "variant" | "mixed";
    variantRatio?: number; // mixed 模式变式占比 0-1
    variantCount?: number; // 每题变式数 1-3
    selectedIds?: string[];
    title?: string;
    difficulty?: "easy" | "medium" | "hard" | "harder";
}

/**
 * 智能组卷：薄弱度加权选题 →（可选）AI 生成定向变式 → 试卷落库（快照式）
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    try {
        const userId = session.user.id;
        const body: GenerateBody = await req.json();

        const mode = body.mode ?? "mixed";
        if (!["original", "variant", "mixed"].includes(mode)) {
            return badRequest("Invalid mode");
        }
        const count = Math.min(MAX_COUNT, Math.max(1, body.count ?? 10));
        const variantCount = Math.min(MAX_VARIANT_COUNT, Math.max(1, body.variantCount ?? 1));
        const variantRatio = Math.min(1, Math.max(0, body.variantRatio ?? 0.5));

        // ── 选题（软推荐：薄弱度加权，优先未掌握）──────────────
        let items: ItemWithRels[];
        if (body.selectedIds && body.selectedIds.length > 0) {
            items = await prisma.errorItem.findMany({
                where: { id: { in: body.selectedIds }, userId },
                include: { tags: true, subject: true },
            });
        } else {
            // 先轻量取打分所需字段，选出 top N 后再取全量关系（避免整库加载）
            const poolLite = await prisma.errorItem.findMany({
                where: {
                    userId,
                    ...(body.subjectId ? { subjectId: body.subjectId } : {}),
                    questionText: { not: null },
                },
                select: { id: true, errorCategory: true, secondaryErrorCategories: true, masteryLevel: true, updatedAt: true },
            });
            // 轻量薄弱度：categoryWeight × masteryFactor × recencyFactor；未掌握优先（因子与统计模型同源）
            const topIds = poolLite
                .map((i) => ({
                    id: i.id,
                    score: categoryWeight(i.errorCategory, i.secondaryErrorCategories)
                        * (WEAKNESS_CONFIG.masteryFactor[i.masteryLevel] ?? 1.0)
                        * recencyFactor(i.updatedAt),
                }))
                .sort((a, b) => b.score - a.score)
                .slice(0, count)
                .map((x) => x.id);
            items = await prisma.errorItem.findMany({
                where: { id: { in: topIds }, userId },
                include: { tags: true, subject: true },
            });
        }

        if (items.length === 0) {
            return badRequest("No eligible error items to build a paper");
        }

        // ── 出题计划：count 为试卷目标题数，池不足时循环池用变式补齐 ──
        const plan = buildPaperPlan(
            items,
            mode,
            count,
            variantRatio,
            variantCount,
            (i) => i.id
        );

        // ── 变式生成（并发池 + 重试 3 次 + 失败降级原题）──────
        const aiService = getAIService();
        const degraded: string[] = [];
        type DraftVariant = { questionText: string; answerText: string; analysis: string; knowledgePoints: string[]; questionType: string };

        async function generateVariantFor(item: ItemWithRels): Promise<DraftVariant | null> {

            const hintParts: string[] = [];
            if (item.errorCategory && item.errorCategory !== "unknown") {
                hintParts.push(`学生主要错因：${getErrorCategoryLabel(item.errorCategory)}`);
            }
            if (item.stuckPoint) {
                hintParts.push(`学生卡壳点：${item.stuckPoint}`);
            }
            const mistakeHint = hintParts.length
                ? `【定向要求】${hintParts.join("；")}。请针对上述薄弱环节设计变式，换角度考查同一易错技能点。`
                : "";

            const tags = item.tags.map((t) => t.name);
            let lastError: unknown = null;
            for (let attempt = 0; attempt < AI_RETRIES; attempt++) {
                try {
                    const q = await aiService.generateSimilarQuestion(
                        item.questionText || "",
                        tags,
                        "zh",
                        body.difficulty ?? "medium",
                        item.gradeSemester,
                        mistakeHint
                    );
                    return {
                        questionText: q.questionText,
                        answerText: q.answerText,
                        analysis: q.analysis,
                        knowledgePoints: q.knowledgePoints,
                        questionType: item.questionType || q.questionType || "solve",
                    };
                } catch (error) {
                    lastError = error;
                }
            }
            logger.warn({ itemId: item.id, error: String(lastError) }, 'Variant generation failed after retries');
            return null;
        }

        // 计划中的变式项并发生成（单题失败 → 降级为原题，不减少题数）
        const variantByPlanIndex = new Map<number, DraftVariant | null>();
        let planCursor = 0;
        await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, plan.length) }, async () => {
                while (planCursor < plan.length) {
                    const idx = planCursor++;
                    if (!plan[idx].isVariant) continue;
                    const variant = await generateVariantFor(plan[idx].item);
                    variantByPlanIndex.set(idx, variant);
                    if (!variant) degraded.push(plan[idx].item.id);
                }
            })
        );

        // ── 组卷：题型分组排序 + 默认分值 ─────────────────────
        interface DraftQuestion {
            section: string; questionType: string; score: number; isVariant: boolean;
            sourceErrorItemId: string | null; questionText: string; answerText: string;
            analysis: string; knowledgePoints: string | null; originalImageUrl: string | null;
        }
        const drafts: DraftQuestion[] = plan.map(({ item, isVariant }, idx) => {
            const v = isVariant ? variantByPlanIndex.get(idx) : undefined;
            if (isVariant && v) {
                return {
                    section: v.questionType,
                    questionType: v.questionType,
                    score: QUESTION_TYPES.find((t) => t.code === v.questionType)?.defaultScore ?? 10,
                    isVariant: true,
                    sourceErrorItemId: item.id,
                    questionText: v.questionText,
                    answerText: v.answerText,
                    analysis: v.analysis,
                    knowledgePoints: JSON.stringify(v.knowledgePoints),
                    originalImageUrl: null,
                };
            }
            // 原题，或变式生成失败后降级为原题
            return {
                section: item.questionType || "solve",
                questionType: item.questionType || "solve",
                score: QUESTION_TYPES.find((t) => t.code === item.questionType)?.defaultScore ?? 10,
                isVariant: false,
                sourceErrorItemId: item.id,
                questionText: item.questionText || "",
                answerText: item.answerText || "",
                analysis: item.analysis || "",
                knowledgePoints: JSON.stringify(item.tags.map((t) => t.name)),
                originalImageUrl: item.originalImageUrl,
            };
        });

        // 大题顺序由 QUESTION_TYPES 定义派生（选择 → 填空 → 判断 → 解答）
        const sectionOrder = QUESTION_TYPES.map((t) => t.code as string);
        drafts.sort((a, b) => sectionOrder.indexOf(a.section) - sectionOrder.indexOf(b.section));

        const totalScore = drafts.reduce((sum, d) => sum + d.score, 0);
        const subjectName = items[0]?.subject?.name;

        const paper = await prisma.practicePaper.create({
            data: {
                userId,
                title: body.title || `${subjectName || "综合"}重做卷 · ${new Date().toLocaleDateString("zh-CN")}`,
                subjectId: body.subjectId || items[0]?.subjectId || null,
                mode,
                status: "ready",
                totalScore,
                questions: {
                    create: drafts.map((d, idx) => ({ ...d, order: idx + 1 })),
                },
            },
            include: { questions: true },
        });

        logger.info({ paperId: paper.id, questions: drafts.length, degraded: degraded.length, mode }, 'Paper generated');

        return NextResponse.json({
            id: paper.id,
            title: paper.title,
            totalScore,
            questionCount: drafts.length,
            degradedCount: degraded.length,
        });
    } catch (error) {
        logger.error({ error }, 'Error generating paper');
        return internalError("Failed to generate paper");
    }
}
