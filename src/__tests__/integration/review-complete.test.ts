/**
 * /api/review/complete 集成测试
 * 纸质复习卷结果录入：未登录/空结果拒绝、归属校验过滤他人错题、复习计划推进链路
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockErrorItem: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
    },
    mockReviewSchedule: {
        findFirst: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
    },
    mockPracticeRecord: {
        createMany: vi.fn(),
    },
    mockSession: {
        user: { id: 'user-123', email: 'user@example.com' },
        expires: '2026-12-31',
    },
}));

// Mock Prisma：$transaction 把同一套 mock 作为 tx 传给回调（与真实行为一致）
vi.mock('@/lib/prisma', () => {
    const prisma = {
        errorItem: mocks.mockErrorItem,
        reviewSchedule: mocks.mockReviewSchedule,
        practiceRecord: mocks.mockPracticeRecord,
    };
    return {
        prisma: {
            ...prisma,
            $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
        },
    };
});

vi.mock('next-auth', () => ({
    getServerSession: vi.fn(() => Promise.resolve(mocks.mockSession)),
}));

vi.mock('@/lib/auth', () => ({ authOptions: {} }));

import { POST } from '@/app/api/review/complete/route';
import { getServerSession } from 'next-auth';

function makeRequest(body: unknown): Request {
    return new Request('http://localhost/api/review/complete', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    // advanceReviewSchedule 链路的默认依赖
    mocks.mockErrorItem.findMany.mockResolvedValue([{ id: 'item-1', subject: null }]);
    mocks.mockErrorItem.findUnique.mockResolvedValue({ masteryLevel: 0 });
    mocks.mockReviewSchedule.findFirst.mockResolvedValue({ id: 'sch-1', reviewCount: 0 });
    mocks.mockReviewSchedule.update.mockResolvedValue({});
    mocks.mockReviewSchedule.create.mockResolvedValue({});
    mocks.mockPracticeRecord.createMany.mockResolvedValue({ count: 1 });
});

describe('POST /api/review/complete', () => {
    it('未登录应返回 401', async () => {
        vi.mocked(getServerSession).mockResolvedValueOnce(null as never);
        const res = await POST(makeRequest({ results: [{ errorItemId: 'item-1', isCorrect: true }] }));
        expect(res.status).toBe(401);
    });

    it('空 results 应返回 400', async () => {
        const res = await POST(makeRequest({ results: [] }));
        expect(res.status).toBe(400);
    });

    it('应过滤非本人错题，只推进归属项', async () => {
        // findMany 只返回本人拥有的 item-1；item-other 属他人
        const res = await POST(
            makeRequest({
                results: [
                    { errorItemId: 'item-1', isCorrect: true },
                    { errorItemId: 'item-other', isCorrect: false },
                ],
            })
        );
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.updatedItems).toBe(1);
        // 计划推进与练习记录只发生一次（item-other 被丢弃）
        expect(mocks.mockReviewSchedule.update).toHaveBeenCalledTimes(1);
        expect(mocks.mockPracticeRecord.createMany).toHaveBeenCalledTimes(1);
    });

    it('答对应完成当前计划、掌握度升级、挂下一条艾宾浩斯计划', async () => {
        const res = await POST(makeRequest({ results: [{ errorItemId: 'item-1', isCorrect: true }] }));
        expect(res.status).toBe(200);

        expect(mocks.mockReviewSchedule.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'sch-1' },
                data: expect.objectContaining({ isCorrect: true, completedAt: expect.any(Date) }),
            })
        );
        // 掌握度 0 → 1
        expect(mocks.mockErrorItem.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'item-1' }, data: { masteryLevel: 1 } })
        );
        // 下一条计划 reviewCount 推进到 1
        expect(mocks.mockReviewSchedule.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ errorItemId: 'item-1', reviewCount: 1 }) })
        );
        expect(mocks.mockPracticeRecord.createMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: [expect.objectContaining({ userId: 'user-123', isCorrect: true })],
            })
        );
    });

    it('答错应重置掌握度并从第 0 阶段重新安排', async () => {
        mocks.mockErrorItem.findUnique.mockResolvedValue({ masteryLevel: 1 });
        const res = await POST(makeRequest({ results: [{ errorItemId: 'item-1', isCorrect: false }] }));
        expect(res.status).toBe(200);
        expect(mocks.mockErrorItem.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'item-1' }, data: { masteryLevel: 0 } })
        );
        expect(mocks.mockReviewSchedule.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ reviewCount: 0 }) })
        );
    });
});
