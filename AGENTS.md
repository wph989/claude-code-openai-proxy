# Repository Guidelines

## 项目结构与模块组织

本仓库是面向 Node.js 22.5+ 的单包 TypeScript ESM 代理服务。`src/cli.ts` 与 `src/server.ts` 负责 CLI 和 Fastify 生命周期；HTTP 路由位于 `src/routes/`，协议转换、Key 调度、SQLite 仓储和上游通信位于 `src/services/`。桌面浏览器管理页使用原生 ESM，资源放在 `src/static/`。测试统一放在 `tests/`，文件名使用 `*.test.ts`。`dist/`、`coverage/`、`logs/`、`pids/` 和 `ccop.db*` 都是生成或运行时文件。

## 构建、测试与开发命令

- `pnpm install`：安装依赖；不要使用 npm。
- `pnpm dev`：通过 `tsx` 启动开发服务。
- `pnpm build`：严格编译 TypeScript，并复制管理端资源。
- `pnpm check`：执行构建及所有管理端 JavaScript 语法检查。
- `pnpm test`：单次运行全部 Vitest 测试。
- `pnpm test:coverage`：运行测试并生成 V8 覆盖率报告。
- `pnpm exec vitest run tests/upstream-retry.test.ts`：定向运行单个测试文件。

## 编码风格与命名

使用两空格缩进、单引号和分号；ESM 相对导入保留 `.js` 后缀。文件名采用 kebab-case，函数和变量使用 camelCase，类型和类使用 PascalCase，模块常量使用 UPPER_SNAKE_CASE。项目启用 TypeScript `strict`，未配置 ESLint 或 Prettier，禁止无关的全仓格式化。复杂状态机、事务和协议边界需写中文注释，解释为什么这样实现。

## 测试与提交

功能变更需覆盖成功路径、错误分类、流式分块、重试、事务并发和持久化回归。覆盖率门槛为行与函数 85%、分支 80%。提交消息使用简洁中文动作摘要，例如 `修复配置迁移并清理兼容入口`；每个提交只包含一个逻辑变更，不添加作者或共同作者尾注。PR 应说明行为变化、迁移影响和已执行的检查；管理端改动附桌面浏览器截图，不做移动端或原生桌面应用适配。

## 安全与迁移

SQLite `ccop.db` 是唯一生产存储。启动时按固定顺序检查配置目录的 `runtime_models.json`、旧版 `config.json`，以及当前项目目录的 `runtime_models.json`，文件存在时自动迁移；也可通过 `MIGRATE_FROM_JSON` 或 `--migrate-from-json` 指定其他源。自动迁移仅在目标库未初始化时读取源文件，已初始化时跳过；显式源文件校验失败或目标不是 CCOP 数据库时必须阻止启动。源文件不会被修改或删除，程序不会扫描目录猜测迁移源。禁止提交 `.env`、数据库、真实 Key、Token 或日志；API、截图和诊断信息必须脱敏。
