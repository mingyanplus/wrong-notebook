# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 语言与 Git 约定

- 所有输出（回复、代码注释、commit message）使用**简体中文**。
- 严禁自动 `git add/commit`，必须经用户确认；提交前展示 `git status` 和 `git diff`。
- Commit 格式：`<type>: <中文描述>`（feat/fix/docs/style/refactor/test/chore/ci），禁止 AI 署名。

## 项目定位

一套「错题记录 + 举一反三」的学习工具：上传错题图片由 AI 解析打标签入库，再基于错题生成同类练习题，配合掌握度与复习计划形成学习闭环。

## 常用命令

```bash
npm run dev                # 开发服务器 (0.0.0.0:3000)
npm run build              # 生产构建（禁止自动执行，除非用户明确要求）
npm run lint               # ESLint (仅 src)

# 测试
npm run test               # Vitest 全量
npm run test:unit          # 单元测试 (src/__tests__/unit)
npm run test:integration   # 集成测试 (src/__tests__/integration)
npm run test:e2e           # Playwright E2E (自动启动 dev server，需先 seed 数据库)
npx vitest run src/__tests__/unit/utils.test.ts          # 运行单个测试文件
npx vitest run -t "部分测试名"                            # 按名称运行单个测试

# 数据库 (SQLite + Prisma)
npx prisma generate        # 生成客户端（CI 在 test/build 前都会执行）
npx prisma migrate dev     # 初始化/迁移
npx prisma db seed         # 种子数据（管理员 admin@localhost / 123456 + 标签）
node scripts/reset-password.js <邮箱> <新密码>
```

- 代码编辑完成后（无错误），默认运行 `npm run test:unit && npm run test:integration`。
- 集成测试通过 `vi.mock` 模拟 Prisma 和 next-auth，**不需要真实数据库**。

## 技术栈

Next.js 16 (App Router) + React 19 + TypeScript (strict) + Tailwind CSS v4 + Shadcn UI + SQLite (Prisma 5.22) + NextAuth.js v4 (credentials provider)。

## 架构

### 三层结构

- `src/app/` — App Router 页面 + `api/` 下的 REST 路由。认证由 `src/middleware.ts` 保护（未登录跳 `/login`，`/admin` 仅 `role === "admin"`）。
- `src/components/` — React 组件；`ui/` 是 Shadcn 原子组件，`settings/`、`admin/` 是业务组件。
- `src/lib/` — 业务逻辑层，是大部分核心逻辑所在。

### AI 服务抽象（src/lib/ai/）

工厂模式：`getAIService()` 每次调用都重新读取配置并返回 `GeminiProvider` / `OpenAIProvider` / `AzureOpenAIProvider`，三者实现统一的 `AIService` 接口（`types.ts`）。AI 返回值经 `schema.ts` 的 Zod 校验；提示词模板在 `prompts.ts`，使用 **XML 标签格式输出（非 JSON）** 以减少格式错误，且可被 `app-config.json` 中的自定义模板覆盖。

### 配置优先级（src/lib/config.ts）

`config/app-config.json`（网页设置保存的运行时配置，优先级最高）> 环境变量 (`.env`) > 代码内 `DEFAULT_CONFIG`。OpenAI 支持多实例管理（`instances` + `activeInstanceId`）。

### 数据模型（prisma/schema.prisma）

核心链路：`User` → `Subject`（错题本）→ `ErrorItem`（错题）。`KnowledgeTag` 是无限层级树（邻接表，`parentId`），分系统预置（`isSystem`，10 学科数据在 `src/lib/tag-data/`）和用户自定义；与 `ErrorItem` 多对多。`ErrorItem.knowledgePoints` 字段已 **DEPRECATED**，仅保留用于迁移。所有关系对 User 级联删除。

### 核心业务流

**记录**：上传图片 → 裁剪压缩 (base64) → `POST /api/analyze`（按用户年级/学科注入标签列表到 prompt → AI 分析 → Zod 校验）→ 用户在 `correction-editor.tsx` 编辑确认（错因/题型/标签一次确认）→ `POST /api/error-items` 保存（含去重检测，自动挂首条艾宾浩斯复习计划）。

**举一反三**：基于错题调用 `/api/practice/generate` 生成相似练习题（`prompts.ts` 的 similar 模板，支持 mistakeHint 错因定向），答题结果经 `/api/practice/record` 记入 `PracticeRecord` 并回写掌握度与复习调度；`/api/reanswer` 让 AI 重新解题。掌握度流转（0 新录 / 1 复习中 / 2 已掌握，答对升级封顶 2、答错重置 0）由 `/api/practice/record`、`/api/practice/paper/[id]/grade` 驱动，艾宾浩斯间隔在 `src/lib/scheduler.ts`（1/2/4/7/15/30 天，之后 ×1.5 递增最长 90 天），到期提醒走 `/api/review/due`。

**错因驱动闭环（2026-09 新增）**：结构化错因体系在 `src/lib/error-categories.ts`（8 核心 + 3 学科扩展，主错因必选权重 1.0 / 次错因 ≤2 权重 0.5）+ 题型字段；薄弱度模型在 `src/lib/weakness.ts`（五因子：错题量×错因权重×掌握度衰减×时间衰减×复习正确率，参数集中在 `weakness-config.ts`）；统计中心"薄弱知识点" tab（`/api/stats/weakness`，知识点×错因热力图）；智能组卷在 `/practice/paper`（`PracticePaper`+`PaperQuestion` 快照式，薄弱度加权选题 + 变式/原题三模式 + 打印答案强制分页 + 录成绩回写全链路）；历史错题可用 `/api/error-items/backfill` 批量补标签/题型/错因。

### 约定

- **错误处理**：API 错误统一用 `@/lib/api-errors`；日志后端用 `@/lib/logger`（自定义实现，替代 pino 以避免 Turbopack 兼容问题），前端用 `@/lib/frontend-logger`。
- **国际化**：所有 UI 文本经 `@/lib/translations.ts`（`t.section.key`），支持 zh/en，fallback 英文。
- **响应式**：必须同时支持 PC 和移动端（Mobile-first）。
- **TypeScript**：避免 `any`（用 `unknown` 或具体类型）；类型导入用 `import type`；React 组件文件 PascalCase，Props 必须有类型，超 200 行需拆分。
- **安全**：用户输入需验证并过滤 XSS；数据库操作用 Prisma 参数化查询；敏感信息存 `.env`，不硬编码。

## 部署

Docker（`next.config.ts` 的 `output: 'standalone'`），entrypoint 为 `docker-entrypoint.sh`。截图功能依赖 HTTPS，见 `doc/HTTPS_SETUP.md`。CI（`.github/workflows/ci.yml`）顺序：unit → integration → build → e2e；tag 推送时构建多架构 Docker 镜像到 ghcr.io。

## 详细文档

`doc/PROJECT_OVERVIEW.md` 有完整目录结构和设计决策说明，值得先读。
