import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { computeWeaknessReport } from "@/lib/weakness";

const logger = createLogger('api:stats:weakness');

/**
 * 知识点薄弱度报告（排行 + 错因热力图）
 * GET /api/stats/weakness?subject=数学&semester=初一，上期
 */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    try {
        const userId = session.user.id;
        const { searchParams } = new URL(req.url);
        const subject = searchParams.get("subject");
        const semester = searchParams.get("semester");

        const items = await prisma.errorItem.findMany({
            where: {
                userId,
                ...(subject ? { subject: { name: subject } } : {}),
                ...(semester && semester !== "all" ? { gradeSemester: semester } : {}),
            },
            select: {
                id: true,
                errorCategory: true,
                secondaryErrorCategories: true,
                masteryLevel: true,
                updatedAt: true,
                gradeSemester: true,
                subjectId: true,
                tags: { select: { id: true, name: true } },
            },
        });

        const itemIds = items.map((i) => i.id);
        const schedules = itemIds.length
            ? await prisma.reviewSchedule.findMany({
                  where: { errorItemId: { in: itemIds }, completedAt: { not: null }, isCorrect: { not: null } },
                  select: { errorItemId: true, isCorrect: true },
              })
            : [];

        const report = computeWeaknessReport(
            items.map((i) => ({
                id: i.id,
                errorCategory: i.errorCategory,
                secondaryErrorCategories: i.secondaryErrorCategories,
                masteryLevel: i.masteryLevel,
                updatedAt: i.updatedAt,
                tags: i.tags,
            })),
            schedules.map((s) => ({ errorItemId: s.errorItemId, isCorrect: !!s.isCorrect }))
        );

        // 可选筛选值（来自全量数据，不受当前筛选影响）
        const unfiltered = !subject && (!semester || semester === "all");
        const semestersFrom = unfiltered ? items : null;
        const liteItems = semestersFrom ?? await prisma.errorItem.findMany({
            where: { userId },
            select: { subjectId: true, gradeSemester: true },
        });
        const subjectIds = Array.from(new Set(liteItems.map((i) => i.subjectId).filter((v): v is string => !!v)));
        const subjectRows = subjectIds.length
            ? await prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { name: true } })
            : [];
        const availableSubjects = subjectRows.map((x) => x.name);
        const availableSemesters = Array.from(
            new Set(liteItems.map((i) => i.gradeSemester).filter((s): s is string => !!s))
        );

        return NextResponse.json({
            availableSubjects,
            availableSemesters,
            totalItems: items.length,
            ...report,
        });
    } catch (error) {
        logger.error({ error }, 'Error computing weakness report');
        return internalError("Failed to compute weakness report");
    }
}
