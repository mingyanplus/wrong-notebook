/**
 * 修复历史数据中被 JSON 解析吞掉的 \f 转义（form feed \x0C）：
 * AI 半转义输出 "\frac" 时，\f 是 JSON 合法转义被静默解析为控制字符，
 * 导致数据库里存成 "\x0Crac"（界面显示为 rac / \rac）。
 *
 * 用法：
 *   node scripts/fix-latex-formfeed.js           # 诊断模式：只统计与预览，不修改
 *   node scripts/fix-latex-formfeed.js --apply   # 执行修复：\x0C → 字面 \f
 */
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const ERROR_ITEM_FIELDS = [
    "questionText",
    "answerText",
    "analysis",
    "ocrText",
    "wrongAnswerText",
    "mistakeAnalysis",
    // GeoGebra 命令的解析路径（analyzeForGeogebra 直接 JSON.parse）不经 extractTag/normalizeLatexEscapes，
    // 入库无归一化防护，存量数据靠此脚本扫描
    "geogebraCommands",
];
const PAPER_QUESTION_FIELDS = ["questionText", "answerText", "analysis"];

// 还原规则与 src/lib/ai/schema.ts 的 normalizeLatexEscapes 保持一致（\x0C → 字面 \f）
function fixText(text) {
    return text.replace(/\f/g, "\\f");
}

async function main() {
    if (!APPLY) {
        console.log("[诊断模式] 仅统计与预览，加 --apply 执行修复\n");
    }

    let affected = 0;
    let updated = 0;

    const scan = async (model, label, fields, findManyArgs) => {
        const rows = await prisma[model].findMany({
            ...findManyArgs,
            select: Object.fromEntries(fields.map((f) => [f, true])),
        });
        for (const row of rows) {
            const data = {};
            let hit = false;
            for (const f of fields) {
                const v = row[f];
                if (typeof v === "string" && /\f/.test(v)) {
                    data[f] = fixText(v);
                    hit = true;
                }
            }
            if (!hit) continue;
            affected++;
            console.log(`[${label}] id=${row.id}`);
            for (const f of Object.keys(data)) {
                const idx = row[f].indexOf("\f");
                console.log(`  ${f}:`);
                console.log(`    修复前: ...${row[f].slice(Math.max(0, idx - 30), idx + 40).replace(/\f/g, "⟨FF⟩")}...`);
                console.log(`    修复后: ...${fixText(row[f]).slice(Math.max(0, idx - 30), idx + 40)}...`);
            }
            if (APPLY) {
                await prisma[model].update({ where: { id: row.id }, data });
                updated++;
            }
        }
    };

    await scan("errorItem", "ErrorItem", ERROR_ITEM_FIELDS, {});
    await scan("paperQuestion", "PaperQuestion", PAPER_QUESTION_FIELDS, {});

    // 顺带统计字面 \rac（AI 直接拼错形态，需人工确认，不自动修）
    const racCount = await prisma.errorItem.count({
        where: { OR: [{ questionText: { contains: "\\rac" } }, { answerText: { contains: "\\rac" } }, { analysis: { contains: "\\rac" } }] },
    });

    console.log(`\n含 form feed（\\f 被吞）的记录: ${affected} 条${APPLY ? `，已修复 ${updated} 条` : "（未修改，加 --apply 执行）"}`);
    console.log(`含字面 \\rac 的错题记录: ${racCount} 条（AI 直接拼错形态，如需修复请人工确认后处理）`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
