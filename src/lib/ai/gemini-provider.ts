import { GoogleGenAI } from "@google/genai";
import { AIService, ParsedQuestion, DifficultyLevel, AIConfig, ReanswerQuestionResult, GeogebraAnalysisResult, BackfillMetaResult } from "./types";
import { generateAnalyzePromptParts, generateSimilarQuestionPromptParts, generateGeogebraPromptParts, generateBackfillPromptParts } from './prompts';
import { safeParseParsedQuestion, parseBackfillResponse, normalizeLatexEscapes } from './schema';
import { getAppConfig, getThinkingLevel, type ThinkingTask, type ThinkingLevel } from '../config';
import { getMathTagsFromDB, getTagsFromDB } from './tag-service';
import { createLogger } from '../logger';
import { normalizeMistakeStatusForSave } from '../mistake-status';
import { parseErrorCategoryCode, parseSecondaryCategories, parseQuestionTypeCode } from '../error-categories';

const logger = createLogger('ai:gemini');

export class GeminiProvider implements AIService {
    private ai: GoogleGenAI;
    private modelName: string;
    private baseUrl: string;

    constructor(config?: AIConfig) {
        const apiKey = config?.apiKey;
        const baseUrl = config?.baseUrl;

        if (!apiKey) {
            throw new Error("AI_AUTH_ERROR: GOOGLE_API_KEY is required for Gemini provider");
        }

        // 使用 httpOptions.baseUrl 来配置自定义 API 地址，避免全局 setDefaultBaseUrls 的竞态条件
        // 参考：@google/genai 的 GoogleGenAIOptions.httpOptions.baseUrl
        this.ai = new GoogleGenAI({
            apiKey,
            httpOptions: baseUrl ? {
                baseUrl: baseUrl
            } : undefined
        });

        this.modelName = config?.model || 'gemini-2.0-flash';
        this.baseUrl = baseUrl || 'https://generativelanguage.googleapis.com';

        logger.info({
            provider: 'Gemini',
            model: this.modelName,
            baseUrl: this.baseUrl,
            apiKeyPrefix: apiKey.substring(0, 8) + '...'
        }, 'AI Provider initialized');
    }

    private async retryOperation<T>(operation: () => Promise<T>, maxRetries: number = 3): Promise<T> {
        let lastError: unknown;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                const msg = error instanceof Error ? error.message.toLowerCase() : String(error);

                // Identify retryable errors
                const isRetryable =
                    msg.includes('fetch failed') ||
                    msg.includes('network') ||
                    msg.includes('connect') ||
                    msg.includes('503') ||
                    msg.includes('502') ||  // Bad Gateway
                    msg.includes('504') ||  // Gateway Timeout
                    msg.includes('overloaded') ||
                    msg.includes('timeout') ||
                    msg.includes('etimedout') ||  // Connection timeout
                    msg.includes('enotfound') ||  // DNS resolution failed
                    msg.includes('econnreset') ||
                    msg.includes('econnrefused') ||  // Connection refused
                    msg.includes('unavailable');

                if (!isRetryable || attempt === maxRetries) {
                    throw error;
                }

                const delay = Math.pow(2, attempt - 1) * 1000; // Exponential backoff: 1s, 2s, 4s
                logger.warn({ attempt, maxRetries, error: msg, nextRetryDelayMs: delay }, 'Gemini operation failed, retrying...');
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError;
    }


    /** 档位 → Gemini thinkingBudget token 数 */
    private static readonly LEVEL_TO_BUDGET: Record<ThinkingLevel, number> = {
        off: 0, low: 2048, medium: 8192, high: 16384, max: 24576,
    };

    /** 按任务构造含思考预算的 generateContent 参数（未配置时省略 = 模型默认动态思考） */
    private genContentOptions(task: ThinkingTask) {
        const level = getThinkingLevel(task);
        return level !== undefined
            ? { config: { thinkingConfig: { thinkingBudget: GeminiProvider.LEVEL_TO_BUDGET[level] } } }
            : {};
    }

    private extractTag(text: string, tagName: string): string | null {
        const startTag = `<${tagName}>`;
        const endTag = `</${tagName}>`;
        const startIndex = text.indexOf(startTag);
        const endIndex = text.lastIndexOf(endTag);

        if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
            return null;
        }

        return normalizeLatexEscapes(text.substring(startIndex + startTag.length, endIndex).trim());
    }

    private parseResponse(text: string): ParsedQuestion {
        logger.debug({ textLength: text.length }, 'Parsing AI response');

        const questionText = this.extractTag(text, "question_text");
        const answerText = this.extractTag(text, "answer_text");
        const analysis = this.extractTag(text, "analysis");
        const subjectRaw = this.extractTag(text, "subject");
        const knowledgePointsRaw = this.extractTag(text, "knowledge_points");
        const requiresImageRaw = this.extractTag(text, "requires_image");
        const wrongAnswerText = this.extractTag(text, "wrong_answer_text") || "";
        const mistakeAnalysis = this.extractTag(text, "mistake_analysis") || "";
        const mistakeStatusRaw = this.extractTag(text, "mistake_status");
        const errorCategory = parseErrorCategoryCode(this.extractTag(text, "error_category"));
        const secondaryErrorCategories = parseSecondaryCategories(this.extractTag(text, "secondary_error_categories"), errorCategory);
        const questionType = parseQuestionTypeCode(this.extractTag(text, "question_type"));

        // Basic Validation
        if (!questionText || !answerText || !analysis) {
            logger.error({ rawTextSample: text.substring(0, 500) }, 'Missing critical XML tags');
            throw new Error("Invalid AI response: Missing critical XML tags (<question_text>, <answer_text>, or <analysis>)");
        }

        // Process Subject
        let subject: ParsedQuestion['subject'] = '其他';
        const validSubjects = ["数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"];
        if (subjectRaw && validSubjects.includes(subjectRaw)) {
            subject = subjectRaw as ParsedQuestion['subject'];
        }

        // Process Knowledge Points
        let knowledgePoints: string[] = [];
        if (knowledgePointsRaw) {
            knowledgePoints = knowledgePointsRaw.split(/[,，\n]/).map(k => k.trim()).filter(k => k.length > 0);
        }

        // Process requiresImage
        const requiresImage = requiresImageRaw?.toLowerCase().trim() === 'true';
        const mistakeStatus = normalizeMistakeStatusForSave(mistakeStatusRaw, wrongAnswerText);

        // Construct Result
        const result: ParsedQuestion = {
            questionText,
            answerText,
            analysis,
            wrongAnswerText,
            mistakeAnalysis,
            mistakeStatus,
            subject,
            knowledgePoints,
            requiresImage,
            errorCategory,
            secondaryErrorCategories,
            questionType
        };

        // Final Schema Validation
        const validation = safeParseParsedQuestion(result);
        if (validation.success) {
            logger.debug('Validated successfully via XML tags');
            return validation.data;
        } else {
            logger.warn({ validationError: validation.error.format() }, 'Schema validation warning');
            return result;
        }
    }

    async analyzeImage(imageBase64: string, mimeType: string = "image/jpeg", language: 'zh' | 'en' = 'zh', grade?: 7 | 8 | 9 | 10 | 11 | 12 | null, subject?: string | null, gradeSemester?: string | null): Promise<ParsedQuestion> {
        const config = getAppConfig();

        // 从数据库获取各学科标签
        const prefetchedMathTags = (subject === '数学' || !subject) ? await getMathTagsFromDB(grade || null) : [];
        const prefetchedPhysicsTags = (subject === '物理' || !subject) ? await getTagsFromDB('physics') : [];
        const prefetchedChemistryTags = (subject === '化学' || !subject) ? await getTagsFromDB('chemistry') : [];
        const prefetchedBiologyTags = (subject === '生物' || !subject) ? await getTagsFromDB('biology') : [];
        const prefetchedEnglishTags = (subject === '英语' || !subject) ? await getTagsFromDB('english') : [];

        // 缓存友好拆分：静态指令放 systemInstruction（命中前缀缓存），标签列表/错因分类/年级约束随图片放 user
        const { systemPrompt, userContext } = generateAnalyzePromptParts(language, grade, subject, {
            customTemplate: config.prompts?.analyze,
            prefetchedMathTags,
            prefetchedPhysicsTags,
            prefetchedChemistryTags,
            prefetchedBiologyTags,
            prefetchedEnglishTags,
        }, gradeSemester);

        logger.box('🔍 AI Image Analysis Request', {
            provider: 'Gemini',
            endpoint: `${this.baseUrl}/v1beta/models/${this.modelName}:generateContent`,
            imageSize: `${imageBase64.length} bytes`,
            mimeType,
            model: this.modelName,
            language,
            grade: grade || 'all'
        });
        logger.box('📝 System Prompt (静态缓存段)', systemPrompt);
        if (userContext) logger.box('📝 User Context (变量段)', userContext);

        try {
            // 用户消息：变量区文本（错因分类/标签列表/年级约束）在前，图片在后
            const userContent = {
                role: 'user',
                parts: [
                    ...(userContext ? [{ text: userContext }] : []),
                    { inlineData: { data: imageBase64, mimeType: mimeType } }
                ]
            };

            // 构建请求参数（用于日志显示）
            const requestParamsForLog = {
                model: this.modelName,
                systemInstruction: `[${systemPrompt.length} chars...]`,
                contents: [
                    ...(userContext ? [{ text: userContext.substring(0, 200) + (userContext.length > 200 ? '...' : '') }] : []),
                    {
                        inlineData: {
                            data: `[...${imageBase64.length} bytes base64 data...]`,
                            mimeType: mimeType
                        }
                    }
                ]
            };

            logger.box('📤 API Request (发送给 AI 的原始请求)', JSON.stringify(requestParamsForLog, null, 2));

            const options = this.genContentOptions('analyze');
            const response = await this.retryOperation(() => this.ai.models.generateContent({
                model: this.modelName,
                ...options,
                config: { ...options.config, systemInstruction: systemPrompt || undefined },
                contents: [userContent]
            }));

            logger.box('📦 Full API Response Metadata', {
                usageMetadata: response.usageMetadata
            });

            const text = response.text || '';

            logger.box('🤖 AI Raw Response', text);

            if (!text) throw new Error("Empty response from AI");
            const parsedResult = this.parseResponse(text);

            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));

            return parsedResult;

        } catch (error) {
            logger.box('❌ Error during AI analysis', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            this.handleError(error);
            throw error;
        }
    }

    async generateSimilarQuestion(originalQuestion: string, knowledgePoints: string[], language: 'zh' | 'en' = 'zh', difficulty: DifficultyLevel = 'medium', gradeSemester?: string | null, mistakeHint?: string): Promise<ParsedQuestion> {
        const config = getAppConfig();
        // 缓存友好拆分：静态模板放 systemInstruction（命中前缀缓存），原题/知识点/难度等变量放 user
        const { systemPrompt, userContext } = generateSimilarQuestionPromptParts(language, originalQuestion, knowledgePoints, difficulty, {
            customTemplate: config.prompts?.similar
        }, gradeSemester, mistakeHint);

        logger.box('🎯 Generate Similar Question Request', {
            provider: 'Gemini',
            endpoint: `${this.baseUrl}/v1beta/models/${this.modelName}:generateContent`,
            originalQuestion: originalQuestion.substring(0, 100) + '...',
            knowledgePoints: knowledgePoints.join(', '),
            difficulty,
            language
        });
        logger.box('📝 System Prompt (静态缓存段)', systemPrompt);
        logger.box('📝 User Context (变量段)', userContext);

        try {
            const options = this.genContentOptions('similar');
            const response = await this.retryOperation(() => this.ai.models.generateContent({
                model: this.modelName,
                ...options,
                config: { ...options.config, systemInstruction: systemPrompt || undefined },
                contents: userContext
            }));

            const text = response.text || '';

            logger.box('🤖 AI Raw Response', text);

            if (!text) throw new Error("Empty response from AI");
            const parsedResult = this.parseResponse(text);

            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));

            return parsedResult;

        } catch (error) {
            logger.box('❌ Error during question generation', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            this.handleError(error);
            throw error;
        }
    }

    async reanswerQuestion(questionText: string, language: 'zh' | 'en' = 'zh', subject?: string | null, imageBase64?: string, gradeSemester?: string | null): Promise<ReanswerQuestionResult> {
        const { generateReanswerPromptParts } = await import('./prompts');
        // 缓存友好拆分：静态指令放 systemInstruction（命中前缀缓存），学科提示/题目内容随图片放 user
        const { systemPrompt, userContext } = generateReanswerPromptParts(language, questionText, subject, undefined, gradeSemester);

        logger.info({
            provider: 'Gemini',
            endpoint: `${this.baseUrl}/v1beta/models/${this.modelName}:generateContent`,
            questionLength: questionText.length,
            subject: subject || 'auto',
            hasImage: !!imageBase64
        }, 'Reanswer Question Request');
        logger.debug({ systemPrompt, userContext }, 'Full prompt');

        try {
            // 用户消息：变量区文本（学科提示/题目内容）在前，图片在后
            const userContent = {
                role: 'user',
                parts: imageBase64
                    ? [
                        { text: userContext },
                        // 移除 data:image/xxx;base64, 前缀（如果存在）
                        { inlineData: { mimeType: 'image/jpeg', data: imageBase64.replace(/^data:image\/\w+;base64,/, '') } }
                    ]
                    : [{ text: userContext }]
            };

            const options = this.genContentOptions('reanswer');
            const response = await this.retryOperation(() => this.ai.models.generateContent({
                model: this.modelName,
                ...options,
                config: { ...options.config, systemInstruction: systemPrompt || undefined },
                contents: [userContent]
            }));

            const text = response.text || '';

            logger.debug({ rawResponse: text }, 'AI raw response');

            if (!text) throw new Error("Empty response from AI");

            // 解析响应
            const answerText = this.extractTag(text, "answer_text") || "";
            const analysis = this.extractTag(text, "analysis") || "";
            const knowledgePointsRaw = this.extractTag(text, "knowledge_points") || "";
            const knowledgePointsParsed = knowledgePointsRaw.split(/[,，\n]/).map(k => k.trim()).filter(k => k.length > 0);
            const wrongAnswerText = this.extractTag(text, "wrong_answer_text") || "";
            const mistakeAnalysis = this.extractTag(text, "mistake_analysis") || "";
            const mistakeStatus = normalizeMistakeStatusForSave(
                this.extractTag(text, "mistake_status"),
                wrongAnswerText
            );

            logger.info('Reanswer parsed successfully');

            return { answerText, analysis, knowledgePoints: knowledgePointsParsed, wrongAnswerText, mistakeAnalysis, mistakeStatus };

        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during reanswer');
            this.handleError(error);
            throw error;
        }
    }

    async analyzeForGeogebra(questionText: string, answerText: string, analysis: string, previousErrors?: string): Promise<GeogebraAnalysisResult> {
        // 缓存友好拆分：静态规范放 systemInstruction（命中前缀缓存），题目内容放 user
        const { systemPrompt, userContext } = generateGeogebraPromptParts(questionText, answerText, analysis, previousErrors);

        logger.info({
            provider: 'Gemini',
            model: this.modelName,
            questionLength: questionText.length,
        }, 'GeoGebra Analysis Request');

        try {
            const options = this.genContentOptions('geogebra');
            const response = await this.retryOperation(() => this.ai.models.generateContent({
                model: this.modelName,
                ...options,
                config: { ...options.config, systemInstruction: systemPrompt || undefined },
                contents: userContext
            }));

            const text = response.text || '';
            logger.debug({ rawResponse: text }, 'GeoGebra AI raw response');

            if (!text) throw new Error("Empty response from AI");

            // Extract JSON from response (handle possible markdown code blocks)
            let jsonStr = text.trim();
            const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                jsonStr = jsonMatch[1].trim();
            }

            // Try to find JSON object
            const objStart = jsonStr.indexOf('{');
            const objEnd = jsonStr.lastIndexOf('}');
            if (objStart !== -1 && objEnd !== -1) {
                jsonStr = jsonStr.substring(objStart, objEnd + 1);
            }

            const parsed = JSON.parse(jsonStr);

            return {
                suitable: Boolean(parsed.suitable),
                commands: Array.isArray(parsed.commands) ? parsed.commands : [],
                description: parsed.description || "",
            };
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during GeoGebra analysis');
            this.handleError(error);
            throw error;
        }
    }

    async backfillMeta(questionText: string, answerText?: string, analysis?: string, wrongAnswerText?: string, subject?: string | null, tagList?: string): Promise<BackfillMetaResult> {
        // 缓存友好拆分：静态规则放 systemInstruction（命中前缀缓存），题目内容放 user
        const { systemPrompt, userContext } = generateBackfillPromptParts({ questionText, answerText, analysis, wrongAnswerText, subject, tagList });

        const options = this.genContentOptions('backfill');
        const response = await this.retryOperation(() => this.ai.models.generateContent({
            model: this.modelName,
            ...options,
            config: { ...options.config, systemInstruction: systemPrompt || undefined },
            contents: userContext
        }));
        const text = response.text || '';
        if (!text) throw new Error("Empty response from AI");

        return parseBackfillResponse(text, (t, tag) => this.extractTag(t, tag));
    }

    private handleError(error: unknown) {
        logger.error({ error }, 'Gemini error');
        if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('connect')) {
                throw new Error("AI_CONNECTION_FAILED");
            }
            // 超时错误 (包括 408 Request Timeout)
            if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted') || msg.includes('408')) {
                throw new Error("AI_TIMEOUT_ERROR");
            }
            // 配额/频率限制错误
            if (msg.includes('quota') || msg.includes('额度') || msg.includes('rate limit') || msg.includes('429') || msg.includes('too many')) {
                throw new Error("AI_QUOTA_EXCEEDED");
            }
            // 权限/403 错误
            if (msg.includes('403') || msg.includes('forbidden') || msg.includes('permission')) {
                throw new Error("AI_PERMISSION_DENIED");
            }
            // 资源不存在/404 错误
            if (msg.includes('404') || msg.includes('not found') || msg.includes('does not exist')) {
                throw new Error("AI_NOT_FOUND");
            }
            // 服务器错误 (500/502/503/504)
            if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') ||
                msg.includes('无可用') || msg.includes('overloaded') || msg.includes('unavailable')) {
                throw new Error("AI_SERVICE_UNAVAILABLE");
            }
            if (msg.includes('invalid json') || msg.includes('parse')) {
                throw new Error("AI_RESPONSE_ERROR");
            }
            if (msg.includes('api key') || msg.includes('unauthorized') || msg.includes('401')) {
                throw new Error("AI_AUTH_ERROR");
            }
        }
        throw new Error("AI_UNKNOWN_ERROR");
    }
}
