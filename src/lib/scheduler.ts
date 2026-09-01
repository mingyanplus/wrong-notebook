import { addDays } from "date-fns";

// Ebbinghaus base intervals in days: 1, 2, 4, 7, 15, 30
const BASE_REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30];
// After the base stages, each interval grows by this factor, capped at MAX_INTERVAL_DAYS
const EXTENDED_GROWTH_FACTOR = 1.5;
const MAX_INTERVAL_DAYS = 90;

export function getReviewIntervalDays(reviewCount: number): number {
    if (reviewCount < BASE_REVIEW_INTERVALS.length) {
        return BASE_REVIEW_INTERVALS[reviewCount];
    }
    // Beyond the base stages: 30 × 1.5^(n), capped at 90 days
    const exponent = reviewCount - BASE_REVIEW_INTERVALS.length + 1;
    return Math.min(Math.round(30 * Math.pow(EXTENDED_GROWTH_FACTOR, exponent)), MAX_INTERVAL_DAYS);
}

export function calculateNextReviewDate(reviewCount: number): Date {
    return addDays(new Date(), getReviewIntervalDays(reviewCount));
}

export function getReviewStageDescription(reviewCount: number): string {
    if (reviewCount < BASE_REVIEW_INTERVALS.length) {
        const labels = [
            "First Review (1 day)",
            "Second Review (2 days)",
            "Third Review (4 days)",
            "Fourth Review (7 days)",
            "Fifth Review (15 days)",
            "Sixth Review (30 days)",
        ];
        return labels[reviewCount];
    }
    return `Extended Review (${getReviewIntervalDays(reviewCount)} days)`;
}
