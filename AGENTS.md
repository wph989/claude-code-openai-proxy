# Repository Guidelines

## 项目结构与模块组织

本仓库是面向 Node.js 20+ 的单包 TypeScript ESM 代理服务。`src/cli.ts` 与 `src/server.ts` 负责命令行和 Fastify 启动；HTTP 入口位于 `src/routes/`，协议转换、上游请求、Key 调度及运行时持久化集中在 `src/services/`，通用基础能力放在 `src/utils/`。管理端静态资源位于 `src/static/`，类型定义位于 `src/types/`。测试统一放在根目录 `tests/`，文件名使用 `*.test.ts`。`dist/`、`coverage/`、`logs/` 和 `pids/` 均为生成或运行时目录，不应手工维护。

## 构建、测试与开发命令

- `pnpm install`：安装依赖；项目统一使用 pnpm。
- `pnpm dev`：通过 `tsx` 直接运行开发模式服务。
- `pnpm build`：执行严格 TypeScript 编译，并运行 `scripts/postbuild.mjs` 复制发布资源。
- `pnpm check`：构建项目，同时检查管理端原生 JavaScript 语法；提交前应运行。
- `pnpm test`：单次运行全部 Vitest 测试；`pnpm test:watch` 用于本地迭代。
- `pnpm test:coverage`：生成 V8 文本及 HTML 覆盖率报告。
- `pnpm start`：从 `dist/` 启动已构建版本，使用前先执行构建。

## 编码风格与命名

沿用现有格式：两空格缩进、单引号和分号。ESM 相对导入必须保留 `.js` 后缀，以兼容 `NodeNext` 输出。文件使用 kebab-case，函数和变量使用 camelCase，类型、接口及类使用 PascalCase，模块级常量使用 UPPER_SNAKE_CASE。`tsconfig.json` 已启用 `strict`、未使用变量检查和大小写一致性检查；仓库未配置 ESLint 或 Prettier，不要引入未经讨论的全仓格式化。复杂边界应添加中文注释，重点解释“为什么”，避免复述代码。

## 测试指南

测试使用 Vitest、Node 环境和显式导入（不启用 globals）。功能变更应覆盖成功路径、错误分类、重试/流式边界及持久化回归。可用 `pnpm exec vitest run tests/upstream-retry.test.ts` 定向运行。覆盖率门槛为行与函数 85%、分支 80%；修改 `vitest.config.ts` 所列核心服务时不得降低门槛。

## 提交与 Pull Request

近期历史采用简洁中文动作摘要，例如 `修复配置回归并优化管理界面`、`新增供应商恢复配置`。每个提交只包含一个逻辑变更；除非明确要求，自动化 Agent 不得提交，也不得添加作者或共同作者尾注。PR 应说明问题、实现范围、配置或 API 兼容性，并列出已执行的检查；关联相关 issue。本项目只提供面向桌面浏览器的 Web 管理页，不开发 Electron、Tauri 等桌面应用。涉及 `src/static/` 的界面改动需附桌面浏览器截图，无需移动端适配或窄屏截图。

## 安全与配置

以 `.env.example` 和 `runtime_models.example.json` 为模板。禁止提交 `.env`、真实 API Key、`runtime_models.json`、运行状态文件或日志；诊断信息与截图中也必须脱敏凭证。
