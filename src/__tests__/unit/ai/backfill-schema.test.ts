/**
 * parseBackfillResponse 的 requires_image 解析单元测试
 */
import { describe, it, expect } from 'vitest';
import { parseBackfillResponse } from '@/lib/ai/schema';

// 简易 extractTag：模拟 provider 的标签提取
const extractTag = (text: string, tagName: string): string | null => {
    const match = text.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`));
    return match ? match[1].trim() : null;
};

const baseResponse = (requiresImageTag?: string) => `
<knowledge_points>有理数, 整式</knowledge_points>
<question_type>choice</question_type>
${requiresImageTag !== undefined ? `<requires_image>${requiresImageTag}</requires_image>` : ''}
<error_category>concept</error_category>
<secondary_error_categories></secondary_error_categories>
`.trim();

describe('parseBackfillResponse requiresImage', () => {
    it('应解析 true', () => {
        const result = parseBackfillResponse(baseResponse('true'), extractTag);
        expect(result.requiresImage).toBe(true);
    });

    it('应解析 false（含大小写与空白容忍）', () => {
        expect(parseBackfillResponse(baseResponse('False'), extractTag).requiresImage).toBe(false);
        expect(parseBackfillResponse(baseResponse(' false '), extractTag).requiresImage).toBe(false);
    });

    it('缺 requires_image 标签时返回 undefined（调用方跳过不覆盖）', () => {
        expect(parseBackfillResponse(baseResponse(), extractTag).requiresImage).toBeUndefined();
    });

    it('非法取值返回 undefined', () => {
        expect(parseBackfillResponse(baseResponse('不确定'), extractTag).requiresImage).toBeUndefined();
        expect(parseBackfillResponse(baseResponse('TRUE!'), extractTag).requiresImage).toBeUndefined();
    });
});
