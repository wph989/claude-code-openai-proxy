# Repository Guidelines

## 项目结构与模块组织

本仓库是 Node.js 22.5+、TypeScript ESM 与 Fastify 实现的单包代理服务。`src/cli.ts` 和 `src/server.ts` 管理 CLI、进程及服务生命周期；公开协议路由位于 `src/routes/`，管理 API 按资源拆分在 `src/routes/admin/`。路由、Key 调度、协议转换、SQLite 仓储和上游通信位于 `src/services/`，共享类型在 `src/types/`，通用工具在 `src/utils/`。桌面浏览器管理端使用原生 ESM，资源位于 `src/static/`。测试统一放在 `tests/`，文件名采用 `*.test.ts`。

## 构建、测试与开发命令

- `pnpm install`：安装依赖；仓库统一使用 pnpm。
- `pnpm dev`：通过 `tsx` 运行开发模式服务。
- `pnpm build`：严格编译 TypeScript，并复制管理端静态资源。
- `pnpm check`：构建并检查管理端 JavaScript 语法。
- `pnpm test`：单次运行全部 Vitest 测试。
- `pnpm test:coverage`：生成 V8 覆盖率报告。
- `pnpm exec vitest run tests/routing-policy.test.ts`：定向运行测试。

## 编码风格与命名

使用两空格缩进、单引号和分号。ESM 相对导入必须保留 `.js` 后缀。文件使用 kebab-case，函数和变量使用 camelCase，类型及类使用 PascalCase，模块常量使用 UPPER_SNAKE_CASE。仓库未配置 ESLint 或 Prettier，不执行无关的全仓格式化。复杂事务、状态机和协议边界应添加中文注释，说明为什么这样处理。

## 测试与变更要求

功能变更需覆盖成功路径、错误分类、流式分块、重试、并发事务和持久化回归。覆盖率门槛为行与函数 85%、分支 80%。提交使用简洁中文动作摘要，例如 `修复自动迁移并更新使用文档`；一个提交只包含一个逻辑变更，不添加作者或共同作者尾注。PR 应描述行为变化、迁移影响和已执行检查；管理端改动附桌面浏览器截图，不做移动端或原生桌面应用适配。

## 安全与存储

`ccop.db` 是唯一运行时数据库。旧配置文件仅用于升级迁移，不再作为配置入口。禁止提交 `.env`、`ccop.db*`、真实 Key、Token、日志或运行目录。普通管理 API、日志、指标、事件和截图必须脱敏；完整 Key 只允许在管理员主动导出时返回。
