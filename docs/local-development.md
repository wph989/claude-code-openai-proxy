# 本地开发指南

本文用于源码开发、调试和本地验证。项目运行环境为 Node.js 22.5+、TypeScript ESM、Fastify、SQLite 和 pnpm。

## 准备环境

```powershell
git clone https://github.com/wph989/claude-code-openai-proxy.git
Set-Location .\claude-code-openai-proxy
pnpm install
Copy-Item .env.example .env
```

修改 `.env` 中的 `ADMIN_AUTH_TOKEN`。开发模式会读取项目根目录 `.env`，并默认使用项目目录的 `ccop.db`。

## 使用独立开发数据库

为了避免修改已有本地数据，建议为开发会话指定单独数据库：

```powershell
pnpm exec tsx src/cli.ts init-config --sqlite-file .\tmp\dev.db
pnpm exec tsx src/cli.ts start --dev --sqlite-file .\tmp\dev.db --port 8766
```

管理端地址为 `http://127.0.0.1:8766/admin`。`tmp/` 已被 Git 忽略，可直接删除并重新初始化。

## 常用命令

```powershell
pnpm dev            # 直接通过 tsx 启动源码，使用 .env 中的端口和数据库
pnpm build          # 清理 dist、执行严格 TypeScript 编译并复制静态资源
pnpm check          # 构建并检查管理端原生 JavaScript 语法
pnpm test           # 单次运行全部 Vitest 测试
pnpm test:watch     # 监听模式运行测试
pnpm test:coverage  # 生成 V8 覆盖率报告
pnpm start          # 从 dist 启动，使用前先执行 pnpm build
```

`pnpm dev` 不包含文件监听重启。修改源码后停止并重新执行该命令；测试迭代可使用 `pnpm test:watch`。

`pnpm start` 从 `dist/` 运行时会被识别为生产模式，默认访问 `~/.ccop/`。需要验证本地开发数据库时，应使用 `pnpm dev` 或显式执行 `tsx src/cli.ts start --dev`。

## 定向测试

```powershell
pnpm exec vitest run tests/passthrough.test.ts
pnpm exec vitest run tests/upstream-retry.test.ts
pnpm exec vitest run tests/runtime-config-migration.test.ts
```

测试使用临时 SQLite 数据库和模拟上游。不要把真实 Key 写入测试、日志或截图。

## 本地调试流程

1. 使用独立端口和 `tmp/dev.db` 启动服务。
2. 在管理端配置测试供应商、Key 和模型映射。
3. 使用 `/livez`、`/readyz` 和 `/metrics` 检查服务状态。
4. 查看 `logs/app.log`，确认客户端模型别名和上游原始模型名。
5. 修改协议或错误处理时，优先运行对应定向测试，再运行完整检查。

PowerShell 请求示例：

```powershell
$headers = @{
  Authorization = 'Bearer your-proxy-token'
  'Content-Type' = 'application/json'
}
$body = @{
  model = 'your-client-model'
  max_tokens = 64
  messages = @(@{ role = 'user'; content = '你好' })
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Method Post `
  -Uri 'http://127.0.0.1:8766/v1/messages' `
  -Headers $headers `
  -Body $body
```

未配置代理 Token 时移除 `Authorization` 请求头。

## 目录定位

```text
src/routes/       HTTP 路由与协议入口
src/services/     上游、转换、Key 调度、配置和持久化
src/static/       桌面浏览器管理端
src/types/        运行时配置类型
tests/            Vitest 回归测试
scripts/          构建清理与静态资源复制
```

ESM 相对导入必须保留 `.js` 后缀。代码使用两空格缩进、单引号和分号；复杂边界的中文注释应说明采用该处理方式的原因。

## 提交前检查

```powershell
pnpm check
pnpm test
git diff --check
git status --short
```

涉及核心服务时再运行 `pnpm test:coverage`。不要提交 `.env`、数据库、日志、PID、覆盖率或临时文件。
