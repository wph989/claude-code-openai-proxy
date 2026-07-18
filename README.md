# Claude Code OpenAI Proxy

Claude Code 多供应商代理（TypeScript ESM）：

- 对外暴露 Anthropic Messages、OpenAI Chat Completions 与 OpenAI Responses 接口
- 对内转发到 OpenAI-compatible 上游，例如 Ollama、vLLM、NIM、各类兼容网关
- 支持多供应商、多模型映射、Web UI 配置管理、配置热生效、JSON 日志
- 全局安装后通过 `ccop` 命令快速启动

## 最近更新

**v0.4.2 (2026-06-12)**
- **模型重名支持**：允许多个路由使用相同的 `client_model`，请求时随机选择（负载均衡/容错）
- **修复 Claude Code 客户端兼容性问题,支持请求透传，用于代理限制接收cc客户端请求的供应商**
- **检查供应商Anthropic SSE 响应自动修复不合规的响应**

**v0.4.1**
- 防封重试和运行态持久化优化
- API Key 轮询与防封重试增强

**v0.4.0**
- 流式 SSE 修复（`StreamingAnthropicSSEFixer`）
- 请求头透传优化（保留客户端身份信息）
- Anthropic 协议严格校验（5 字段 usage、stop_reason 映射）

## 主要特性

- **协议转换**：Anthropic ↔ OpenAI 自动转换
- **多供应商**：支持多个上游供应商，自动故障切换
- **配置管理**：Web UI 表单化配置，热生效无需重启
- **守护进程**：支持后台运行、自动记录 PID
- **便捷 CLI**：`ccop start/stop/status/ui` 命令
- **日志**：结构化 JSON 日志，支持日志级别控制
- **可观测性**：提供存活/就绪检查和 Prometheus 指标
- **可靠持久化**：SQLite WAL、显式 schema migration、Key lease 与多 Worker 事务协调
- **预算与告警**：按输入/输出 Token 估算费用，并可发送脱敏 Webhook 告警

## 目录结构

```text
src/
  cli.ts              # CLI 入口 (ccop 命令)
  server.ts           # Fastify 服务
  config.ts           # 配置管理
  auth.ts             # 认证中间件
  models.ts           # 数据模型
  routes/
    admin.ts            # 管理后台 API
    health.ts           # 存活、就绪与 Prometheus 指标
    messages.ts         # Anthropic Messages API
    chat-completions.ts # OpenAI Chat Completions 透传
    responses.ts        # OpenAI Responses 透传
  services/
    runtime-config.ts   # 运行时配置
    transformers.ts     # 协议转换
    upstream.ts         # 上游请求 + 重试预算
    stream-bridge.ts    # 流式响应桥
    metrics.ts          # 低基数 Prometheus 指标
    api-key-rotator.ts  # 多 Key 调度器（acquire/release/markError）
    anti-ban-config.ts  # anti-ban 字段归一化与 mode 预设
    key-selectors.ts    # Sticky（咬住可用 Key）/ Balanced（随机）选择器
    quota-guard.ts      # 本地配额软停
    usage-budget.ts     # Token/费用累计与预算判断
    alerts.ts           # 脱敏 Webhook 告警
    config/             # SQLite 仓储、schema migration 与共享运行态协调器
  static/
    login.html        # 登录页
    index.html        # 管理页
  utils/
    pid.ts            # 进程管理
    logger.ts         # 日志工具
    nanoid.ts         # 短稳定 id 生成（api_key.id）
    id.ts             # 请求 id 生成
    time.ts           # 时间工具
```

## 安装

要求 Node.js 22.5+ 和 pnpm。

### 方式一：全局安装（推荐）

```bash
pnpm add -g claude-code-openai-proxy
```

### 方式二：npx 直接运行（无需安装）

```bash
pnpm dlx claude-code-openai-proxy start
```

## 快速开始

### 1. 初始化配置

```bash
ccop init-config
```

这会在 SQLite 中创建默认配置，默认数据库为开发目录 `runtime.db`，生产目录为 `~/.ccop/runtime.db`。
旧版 JSON 配置必须显式迁移，不会被启动流程自动读取：

```powershell
pnpm exec ccop migrate --config .\runtime_models.json --sqlite-file .\runtime.db --dry-run
pnpm exec ccop migrate --config .\runtime_models.json --sqlite-file .\runtime.db
```

### 2. 编辑配置

```bash
# Linux/macOS
ccop ui

# Windows 手动打开
# http://127.0.0.1:8765/admin
```

### 3. 启动服务

**前台运行（开发调试）：**

```bash
ccop start
```

**后台守护进程（生产环境）：**

```bash
ccop start -d
# 或
ccop start --daemon
```

**指定端口：**

```bash
ccop start --port 8766 --daemon
```

### 4. 查看状态

```bash
ccop status
# 输出: ✓ 服务运行中 - Port: 8765, PID: 12345
```

### 5. 停止服务

```bash
ccop stop
# 自动读取运行时的端口，无需指定
```

### 6. 打开管理界面

```bash
ccop ui
```

自动打开浏览器访问管理后台。

## CLI 命令参考

| 命令 | 说明 |
|------|------|
| `ccop start` | 前台启动服务（生产模式） |
| `ccop start --dev` | 前台启动（开发模式，使用本地配置） |
| `ccop start -d` | 后台守护模式启动 |
| `ccop start --port 8766` | 指定端口启动 |
| `ccop stop` | 停止服务（自动读取端口） |
| `ccop status` | 查看服务状态 |
| `ccop ui` | 打开管理界面 |
| `ccop init-config` | 初始化 SQLite 配置 |
| `ccop migrate --config <path>` | 显式导入旧 JSON 配置、状态、用量和历史 |
| `ccop --version` | 查看版本 |

### 开发模式 vs 生产模式

| 模式 | 启动方式 | 配置位置 | 日志位置 | PID 位置 |
|------|---------|---------|---------|---------|
| **开发** | `ccop start --dev`<br>或 `NODE_ENV=development ccop start`<br>或 `pnpm dev` | 项目目录 `.env`<br>项目目录 `runtime.db` | 项目目录 `logs/app.log` | 项目目录 `pids/` |
| **生产** | `ccop start` | `~/.ccop/.env`<br>`~/.ccop/runtime.db` | `~/.ccop/logs/app.log` | `~/.ccop/pids/` |

生产模式下所有配置数据都在 `~/.ccop/`，方便备份和迁移；开发模式下配置与项目代码在一起。

## 环境变量

根据启动模式，`.env` 文件位置不同：

| 模式 | `.env` 位置 |
|------|-------------|
| 开发模式 | 项目根目录 `.env` |
| 生产模式 | `~/.ccop/.env`（首次运行自动生成） |

### 常用环境变量

```bash
# 服务监听配置
HOST=0.0.0.0
PORT=8765

# 认证令牌（生产首次运行会在 ~/.ccop/.env 中自动生成随机值）
ADMIN_AUTH_TOKEN=change-me-random-admin-token

# SQLite 数据库（Node.js 22.5+；相对路径以配置根目录为基准）
SQLITE_FILE=./runtime.db

# 可选脱敏告警；Webhook URL 不会在管理 API 或日志中回显
ALERT_WEBHOOK_URL=
ALERT_BUDGET_THRESHOLD=0.85
ALERT_COOLDOWN_SECONDS=300

# 日志配置
LOG_LEVEL=info          # debug, info, warn, error
LOG_FORMAT=json         # json, text
LOG_DETAILED=false      # 是否允许显式安全诊断事件；始终不记录正文或凭证
```

## 旧 JSON 配置示例

`runtime_models.example.json` 仅用于理解字段或作为旧数据迁移源；生产运行时配置由管理端写入 SQLite，不读取该 JSON。

```json
{
  "revision": 1,
  "providers": [
    {
      "provider_id": "openai-compatible",
      "provider_type": "openai_compatible",
      "base_url": "https://api.example.com/v1",
      "capabilities": { "responses": false, "models": true },
      "api_key_env": "PROVIDER_API_KEY",
      "api_key": [
        {
          "id": "EXAMPLE001",
          "key": "sk-example-key-1",
          "enabled": true,
          "quota": {
            "max_requests": 1000,
            "max_tokens": null,
            "max_cost_usd": 5,
            "input_cost_per_million": 2,
            "output_cost_per_million": 8,
            "soft_stop_threshold": 0.95
          }
        },
        { "id": "EXAMPLE002", "key": "sk-example-key-2", "enabled": true }
      ],
      "key_rotation_strategy": "round_robin",
      "auto_disable_on_error": true,
      "auto_recover_minutes": 0,
      "timeout_seconds": 300,
      "circuit_breaker": { "failure_threshold": 3, "recovery_seconds": 30 },
      "enabled": true,
      "headers": {},
      "description": "示例供应商"
    }
  ],
  "models": [
    {
      "route_id": "ROUTE00001",
      "client_model": "claude-model",
      "provider_id": "openai-compatible",
      "upstream_model": "your-upstream-model",
      "priority": 0,
      "weight": 1,
      "enabled": true,
      "extra_body": {},
      "description": "示例模型映射"
    }
  ],
  "default_client_model": "claude-model",
  "proxy_auth_token": null,
  "anti_ban": { "mode": "conservative" }
}
```

`api_key` 支持单字符串或对象数组：数组项可单独配 `enabled`、`quota`、`note` 等字段。`id`、`route_id` 和 `revision` 缺失时会自动生成；管理端依靠这些稳定 ID 与版本号避免重排误操作和并发覆盖。多数场景只需要配置 `anti_ban.mode`，其他字段都有保守默认值。

### Provider 能力与 Responses API

能力由 `provider_type` 的固定矩阵决定，不根据 URL、Key 或模型名猜测。两类 Provider 都支持 `/v1/messages`、`count_tokens` 和模型列表；只有 `openai_compatible` 支持 `/v1/chat/completions`。由于兼容网关不一定实现 Responses，`/v1/responses` 默认关闭，确认上游支持后显式配置：

```json
"capabilities": { "responses": true, "models": true }
```

Responses 的非流式 JSON 和流式 SSE 均沿用现有 Key lease、重试、熔断、配额及指标链路；代理会把响应中的内部模型名改回客户端模型别名。若 `models` 设为 `false`，管理端连接测试不会请求上游 `/models`。

### 模型重名与负载均衡

允许多个路由使用相同的 `client_model` 名称。请求时先排除停用 Provider、无可用 Key、本地配额阻断和熔断冷却中的候选，再选择数值最小的 `priority` 组，并按 `weight` 做加权分配：

```json
{
  "providers": [
    { "provider_id": "openai", "base_url": "https://api.openai.com/v1", "api_key": "sk-...", "circuit_breaker": { "failure_threshold": 3, "recovery_seconds": 30 } },
    { "provider_id": "azure", "base_url": "https://azure.openai.azure.com", "api_key": "...", "circuit_breaker": { "failure_threshold": 3, "recovery_seconds": 30 } },
    { "provider_id": "deepseek", "base_url": "https://api.deepseek.com", "api_key": "sk-..." }
  ],
  "models": [
    { "client_model": "gpt-4", "provider_id": "openai", "upstream_model": "gpt-4-turbo", "priority": 0, "weight": 3 },
    { "client_model": "gpt-4", "provider_id": "azure", "upstream_model": "gpt-4", "priority": 0, "weight": 1 },
    { "client_model": "gpt-4", "provider_id": "deepseek", "upstream_model": "gpt-4", "priority": 10, "weight": 1 }
  ]
}
```

上例正常状态下按 3:1 使用 OpenAI 与 Azure；只有优先级 0 的候选都不可用时才使用 DeepSeek。`priority` 默认 0，`weight` 默认 1；同优先级全部权重为 0 时均匀回退。配合 `enabled: false` 可以临时禁用某个路由：

```json
{ "client_model": "gpt-4", "provider_id": "azure", "upstream_model": "gpt-4", "enabled": false }
```

Provider 默认连续 3 次网络异常或 5xx 后熔断 30 秒；冷却结束只允许一个半开探测，成功后关闭熔断，失败则重新冷却。429、鉴权、配额和请求大小错误不打开熔断。配置 `"circuit_breaker": null` 可关闭该 Provider 的熔断。熔断后续请求会选择其他健康候选；代理不会在已经向上游发送的同一次请求中跨 Provider 自动重放，以免造成重复计费。

**使用场景：**
- **负载分散**：把流量分散到多个供应商，避免单点配额消耗
- **容错冗余**：某个供应商故障时，其他供应商自动接管
- **成本优化**：混合使用价格不同的供应商，平摊成本
- **地域优化**：配置多个地域的同款模型，自动选择可用节点


## SQLite 持久化与迁移

`runtime.db` 是唯一生产运行时存储，统一保存配置、最近 50 个历史快照、Key lease/状态/用量和 Provider 熔断状态。数据库启用 WAL、显式 schema migration、revision CAS、事务 lease 和 TTL 回收，可供多个 Worker 共享。

每个 Key 使用稳定 `id`，状态与用量以 `${providerId}:${keyId}` 为主键；Key 字面量不会进入运行态主键。迁移命令可原子导入旧 `runtime_models.json`、`runtime_state.json`、`runtime_usage.json` 和 `runtime_history.json`，要求目标库尚未初始化，且不会修改源文件。迁移成功后请备份并移除旧 JSON，避免误以为它仍会影响运行时。


## 防封策略（anti-ban）

代理内置三层防御，专为 Claude Code 长任务被 429 / 配额错误中断而设计：

1. **智能选择器**（`Sticky` / `Balanced`）：sticky 咬住当前可用 Key，仅在其失败或不可用时切换；balanced 在可用 Key 间随机分散流量。
2. **代理内有预算重试**（`UpstreamService`）：遇到 429 / 5xx 等可恢复错误，以及单个 Key 配额耗尽、失效等 Key 级 hard limit 时，在 `max_attempts` 与 `max_total_ms` 双重限制下自动换 Key 重试，对路由层透明。
3. **本地配额守护**（`QuotaGuard` + SQLite 协调器）：每个 Key 可配请求、Token 或美元预算，接近上限自动软停用（不翻 `enabled`，admin 重置后立刻恢复）；用量与 lease 在同一共享存储中事务更新。

费用按 `input_cost_per_million` 与 `output_cost_per_million` 乘以上游真实 usage 估算，`max_cost_usd` 参与同一 `soft_stop_threshold` 判断。未配置任何费用字段时继续使用旧的 `{ requests_used, tokens_used }` 持久化形状。

配置 `ALERT_WEBHOOK_URL` 后，预算达到 `ALERT_BUDGET_THRESHOLD` 或 Provider 熔断打开时发送低基数摘要；按 `ALERT_COOLDOWN_SECONDS` 去重。Payload 不含 Key、模型名、请求/会话 ID 或正文，Webhook URL 本身也不会回显。

`anti_ban.mode` 提供两套预设：`conservative`（默认，保守串行）与 `throughput`（更高并发与更短间隔）。建议优先只改这个字段；确实需要细调时，provider 级 `anti_ban` 会覆盖全局值。常用覆盖项：

- `key_selection: sticky | balanced` —— sticky 模式咬住当前可用 Key；balanced 模式在可用 Key 间随机分散。
- `sticky_on_cooldown: fallthrough | wait` —— sticky 命中冷却时是否降级到下一个候选。
- `retry.max_attempts` / `retry.max_total_ms` —— 控制代理内自动重试的次数与总耗时预算。
- `stream_idle_timeout_seconds`（provider 级）—— 流式响应超过该空闲时长视为僵死，记录当前 Key 故障并用兼容事件结束本次流；后续请求会自动避开故障 Key。

### 自动切换与流式边界

代理会在尚未向客户端输出响应体前自动切换可用 Key，因此 429、5xx、网络瞬时错误、单 Key 配额耗尽或 Key 失效通常不会直接暴露给客户端。流式响应已经开始输出后，代理不会尝试 token 级续写；上游中途断流时会输出协议兼容的结束/错误事件、释放当前 Key，并让后续请求自动选择健康 Key。

### 健康检查与 Prometheus 指标

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/livez` | 进程存活检查 |
| `GET` | `/readyz` | 配置初始化完成后返回 revision，否则返回 503 |
| `GET` | `/metrics` | Prometheus 文本格式指标 |

对外协议端点还包括 `POST /v1/messages`、`POST /v1/messages/count_tokens`、`POST /v1/chat/completions` 和 `POST /v1/responses`。Responses 仅路由到显式启用 `capabilities.responses` 的 OpenAI-compatible Provider。

指标覆盖请求量、状态码、延迟、TTFB、活跃请求、上游错误/重试及上游返回的输入/输出 Token。标签只使用路由模板、状态类别和 `provider_type` 等低基数字段，不包含 Key、模型名、查询参数或请求 ID。未返回 usage 的上游不会被估算 Token。

管理端通过 `GET /api/admin/events` 建立带 Cookie 鉴权的 SSE 连接，活动日志会接收配置、Provider、Key、配额和请求摘要变化；服务端只保留最近 100 条脱敏事件，支持 `Last-Event-ID` 重连补发。供应商列表的“测试”操作只执行能力矩阵允许的 `GET /models`，不会调用生成模型。

### Admin 端点

配置接口使用乐观并发控制：`GET /api/config` 返回脱敏 DTO 与 `ETag`；所有配置写入和预览请求都必须携带对应的 `If-Match`。旧版本写入返回 `409 Conflict`，缺少版本返回 `428 Precondition Required`。普通配置响应不包含完整 Key、代理 Token 或敏感 Header 值。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/config` | 获取脱敏配置、运行态和当前 revision |
| `POST` | `/api/config/preview` | 服务端生成不含秘密的字段级变更摘要 |
| `PUT` | `/api/config/proxy-token` | 独立轮换或移除代理 Token |
| `PATCH` | `/api/settings` | 更新全局代理与防封设置 |
| `POST` | `/api/providers` | 创建 Provider |
| `PATCH` / `DELETE` | `/api/providers/:providerId` | 更新或删除 Provider |
| `POST` | `/api/providers/:providerId/test` | 使用 `GET /models` 主动测试连接，不产生模型生成请求 |
| `POST` | `/api/routes` | 创建模型路由并返回稳定 `route_id` |
| `PATCH` / `DELETE` | `/api/routes/:routeId` | 按稳定 ID 更新或删除模型路由 |

Key 与配额管理（均在 `/api/keys/:providerId/...` 下）：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET`    | `/api/keys/:providerId`                        | 列出 Key ID、掩码、运行态与配额状态 |
| `GET`    | `/api/keys/:providerId/export`                 | 使用管理员登录态主动导出完整 Key |
| `POST`   | `/api/keys/:providerId`                        | 新增 Key |
| `DELETE` | `/api/keys/:providerId/:keyId`                 | 删除 Key |
| `PUT`    | `/api/keys/:providerId/:keyId/enable`          | 启用 |
| `PUT`    | `/api/keys/:providerId/:keyId/disable`         | 禁用 |
| `PUT`    | `/api/keys/:providerId/:keyId/reset`           | 清零错误计数 |
| `PUT`    | `/api/keys/:providerId/reset-all`              | 批量清零错误计数 |
| `PUT`    | `/api/keys/:providerId/:keyId/note`            | 修改备注 |
| `POST`   | `/api/keys/:providerId/:keyId/quota/reset`     | 清零本地 usage 计数 |
| `PUT`    | `/api/keys/:providerId/:keyId/quota`           | 更新或清除 `quota`（in-place 应用，保留运行态） |

Key 路由只接受稳定 ID，不再解释纯数字旧索引。Admin UI（`/admin`）只持有脱敏配置，原始 JSON 展示已替换为服务端变更预览；完整 Key 仅在管理员主动导出响应中出现。

详细设计文档：`docs/superpowers/specs/2026-06-06-anti-ban-strategies-design.md`。

## 接入 Claude Code

设置环境变量：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8765
export ANTHROPIC_AUTH_TOKEN=your-proxy-auth-token
```

然后在 Claude Code 中选择 Anthropic API 即可。

## 开发

```bash
# 安装依赖
pnpm install

# 开发模式（热加载）
pnpm dev

# 构建
pnpm build

# 本地运行
pnpm start

# 测试
pnpm test          # 跑一次 vitest
pnpm test:watch    # 监听模式
pnpm test:coverage # 覆盖率报告（@vitest/coverage-v8）
```

## 发布到 npm

### 1. 登录 npm

```bash
pnpm login
```

### 2. 版本更新

```bash
# 更新版本号（遵循 semver）
pnpm version patch   # 修复版: 0.1.0 -> 0.1.1
pnpm version minor   # 小版本: 0.1.0 -> 0.2.0
pnpm version major   # 大版本: 0.1.0 -> 1.0.0
```

### 3. 构建并发布

```bash
pnpm build
pnpm publish --access public --no-git-checks
```

#### 撤销发布
```bash
pnpm unpublish claude-code-openai-proxy@0.2.0 --force
```

### 4. 更新标签（可选）

```bash
# 发布 beta 版
pnpm version prerelease --preid=beta
pnpm publish --tag beta

# 发布 next 版
pnpm publish --tag next
```

### 发布后验证

```bash
# 等待 npm 同步（约 1-5 分钟）
pnpm view claude-code-openai-proxy versions

# 全局安装测试
pnpm add -g claude-code-openai-proxy
ccop --version
```

## License

MIT

## github地址

如果觉得有用，还请给个star
**https://github.com/wph989/claude-code-openai-proxy**
