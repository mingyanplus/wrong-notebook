/**
 * 薄弱度模型参数（grilling 定案：所有参数集中此处可调，UI 不暴露）
 * 薄弱度 = 错题量 × 错因权重 × 掌握度衰减 × 时间衰减 × 复习正确率调节
 */
export const WEAKNESS_CONFIG = {
    /** 次错因权重相对主错因的比例 */
    secondaryWeightRatio: 0.5,
    /** 未分类错因的默认权重 */
    uncategorizedWeight: 1.0,
    /** 掌握度衰减因子：0 新录（最需关注）/ 1 复习中 / 2 已掌握 */
    masteryFactor: { 0: 1.0, 1: 0.6, 2: 0.2 } as Record<number, number>,
    /** 时间衰减半衰期（天）：越久未更新权重越低 */
    recencyHalfLifeDays: 30,
    /** 时间衰减下限（不归零，长期未复习的仍保留关注） */
    recencyFloor: 0.3,
    /** 复习正确率调节范围：全错 ×max，全对 ×min */
    correctnessBoostMax: 1.2,
    correctnessBoostMin: 0.6,
    /** 热力图最多展示的知识点行数 */
    heatmapTopTags: 15,
} as const;
