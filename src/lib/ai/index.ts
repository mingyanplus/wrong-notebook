import { AIService } from "./types";
import { GeminiProvider } from "./gemini-provider";
import { OpenAIProvider } from "./openai-provider";
import { AzureOpenAIProvider } from "./azure-provider";

export * from "./types";

import { getAppConfig, getActiveOpenAIConfig } from "../config";
import { createLogger } from "../logger";

const logger = createLogger('ai');

export function getAIService(): AIService {
    // Always get fresh config
    const config = getAppConfig();
    const provider = config.aiProvider;

    // 后端 SDK 请求超时：环境变量 > 网页「AI 分析超时」设置 > 默认 10 分钟。
    // 网页 timeouts.analyze 原本只控制前端等待，此处打通到后端，避免前端还在等、后端 SDK 已先断
    const requestTimeoutMs =
        Number(process.env.AI_HTTP_TIMEOUT) || Math.max(600_000, config.timeouts?.analyze ?? 0);

    if (provider === "openai") {
        const activeConfig = { ...getActiveOpenAIConfig(), requestTimeoutMs };
        logger.info({ activeInstance: activeConfig?.name }, 'Using OpenAI Provider');
        return new OpenAIProvider(activeConfig);
    } else if (provider === "azure") {
        logger.info({ deployment: config.azure?.deploymentName }, 'Using Azure OpenAI Provider');
        return new AzureOpenAIProvider({ ...config.azure, requestTimeoutMs });
    } else {
        logger.info('Using Gemini Provider');
        return new GeminiProvider(config.gemini);
    }
}

