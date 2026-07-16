# 架构与功能模块文档

本文档描述 `claude-code-openai-proxy` 的整体架构、各模块职责以及关键数据流，作为后续维护与重构的参考。

## 1. 项目定位

- 多供应商 LLM 代理网关，对外暴露 **Anthropic Messages API** (`/v1/messages`) 与 **OpenAI Chat Completions API** (`/v1/chat/completions`)。
- 对内可转发到两类上游：
  - `openai_compatible`：OpenAI 兼容网关（含 oneapi、自建反向代理等）
  - `anthropic`：Anthropic 原生 Messages API
- 内置 API Key 轮询、429 冷却、本地配额守护、错误自动禁用等"防封"机制。
- 提供管理后台（`/admin`）用于编辑供应商、模型路由、Key 状态。

## 2. 顶层目录

```
src/
  cli.ts              # 命令行入口（start/stop/status/ui/init-config）
  server.ts           # Fastify 应用构造与生命周期
  cluster.ts          # 集群模式（master/worker fork 与回收）
  config.ts           # 环境变量、运行模式、目录解析
  auth.ts             # 代理鉴权 + 管理后台鉴权
  models.ts           # 运行时配置的类型与校验/标准化
  routes/
    health.ts         # GET /healthz
    admin.ts          # 管理后台静态资源与 REST API
    chat-completions.ts  # POST /v1/chat/completions
    messages.ts          # POST /v1/messages、count_tokens、GET /v1/models
  services/
    runtime-config.ts # 运行时配置管理器（核心协调者）
    upstream.ts       # 上游 HTTP 调用 + 错误分类 + 重试
    passthrough.ts    # SSE/JSON 响应透传与修复
    stream-bridge.ts  # OpenAI SSE → Anthropic SSE 桥接
    stream-read.ts    # 流式 reader 读取（超时 + abort）
    response-fix.ts   # Anthropic SSE 修复状态机
    transformers.ts   # Anthropic ↔ OpenAI 协议消息互转
    http-headers.ts   # 请求/响应头白名单与转发策略
    response-headers.ts  # （遗留兼容层，已无外部引用）
    api-key-rotator.ts   # API Key 轮询 + 配额
    key-selectors.ts     # Sticky / Balanced 两种选择器
    quota-guard.ts       # 本地请求/Token 配额守护
    anti-ban-config.ts   # 防封参数解析与默认值
    key-state-store.ts   # 运行态持久化（error_count / disabled 等）
    usage-store.ts       # 配额计数持久化
  utils/
    logger.ts         # 结构化日志 + 日志轮转
    pid.ts            # 进程 PID/Port 文件
    atomic-write.ts   # JSON 原子写
    id.ts             # 请求 ID（uuid）
    nanoid.ts         # Crockford base32 短 ID（Key 主键）
    time.ts           # 北京时间格式化
```

## 3. 功能模块说明

### 3.1 入口与启动 (`cli.ts`、`server.ts`、`cluster.ts`、`config.ts`)

- **`cli.ts`** 基于 commander 提供命令行子命令。`start` 支持守护进程（`-d`）与单 Worker 集群兼容模式（`-c`）；本地状态存储会拒绝多 Worker。
- **`config.ts`** 决定运行模式（dev/prod）、配置根目录（生产为 `~/.ccop`），生成默认 `.env` 与 `runtime_models.json`，并把所有环境变量统一在 `settings` 对象。
- **`server.ts`** 注册 cookie、rate-limit、错误处理、请求 ID 钩子，并把 `RuntimeConfigManager` / `UpstreamService` 装饰到 `FastifyInstance` 上供路由层使用。
- **`cluster.ts`** 在主进程 fork 单个 worker，处理子进程退出与优雅关闭；多 Worker 需先接入集中式状态存储。

### 3.2 路由层 (`routes/`)

| 路由 | 职责 |
|---|---|
| `health.ts` | 健康检查 `/healthz` |
| `admin.ts` | 管理后台页面、登录、配置编辑、Key 管理 |
| `chat-completions.ts` | OpenAI 风格 `POST /v1/chat/completions`（仅支持 openai_compatible 上游） |
| `messages.ts` | Anthropic 风格 `POST /v1/messages`、`count_tokens`、`GET /v1/models` |

`messages.ts` 内部按上游类型分两条主线：
1. `provider_type === 'anthropic'` → 透传 + SSE 修复（`passthrough.ts`）
2. `provider_type === 'openai_compatible'` → 协议转换 + SSE 桥接（`transformers.ts` + `stream-bridge.ts`）

### 3.3 配置与数据模型 (`models.ts`、`services/runtime-config.ts`、`services/anti-ban-config.ts`)

- **`models.ts`** 包含所有运行时配置类型 + `normalizeRuntimeConfig` / `validateRuntimeConfig` / `stripRuntimeFromConfig`。
- **`services/runtime-config.ts`** 是核心协调者：
  - 加载/保存 `runtime_models.json`
  - 持久化运行态到 `runtime_state.json` / `runtime_usage.json`
  - 为每个 provider 维护一个 `ApiKeyRotator`
  - 暴露 Key 的 CRUD（启用/禁用/重置/添加/删除/配额）
- **`anti-ban-config.ts`** 把多层默认值（全局/供应商/preset）合并成 `ResolvedAntiBan`，供 rotator 使用。

### 3.4 API Key 轮询与防封 (`api-key-rotator.ts`、`key-selectors.ts`、`quota-guard.ts`)

```
                ┌─────────────────┐
                │  ApiKeyRotator  │
                └────────┬────────┘
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
     KeySelector                  QuotaGuard
     (sticky/                     (本地请求/
      balanced)                    token 配额)
```

- **`api-key-rotator.ts`** 负责 acquire / release lease、并发上限、min_interval、429 冷却等运行时控制。
- **`key-selectors.ts`** 实现两种选择策略：sticky（咬住活跃 Key，失败后切换）/ balanced（在可用 Key 中随机）。
- **`quota-guard.ts`** 比较累计 usage 与 quota（max_requests / max_tokens / soft_stop_threshold），决定是否屏蔽。

### 3.5 持久化 (`key-state-store.ts`、`usage-store.ts`、`utils/atomic-write.ts`)

> **存储抽象规划**：未来若切换到 SQLite，会把 state/usage/config 的读写抽象成 `ConfigRepository` 接口，当前 JSON 文件实现作为该接口的默认实现。本次重构会先预留这层抽象，但保留 JSON 实现不变。

- 三个文件都通过 `writeJsonAtomic` 写入（`writeFile` 到 `.tmp` → `rename`），避免半写状态。
- `KeyStateStore` 主键为 `${providerId}:${keyId}`，使用稳定的 nanoid，避免 Key 字面量变更丢失历史。
- `UsageStore` 采用"批次阈值 + 临界值"双触发刷盘，平衡性能与一致性。

### 3.6 上游通讯 (`services/upstream.ts`、`services/http-headers.ts`)

- **`upstream.ts`** 封装 fetch（undici Agent）：
  - 自动加上鉴权头（OpenAI 用 `Authorization: Bearer`、Anthropic 用 `x-api-key`）
  - 错误分类 (`classifyUpstreamError`) → `hard_limit` / `rate_limit` / `request_limit` / `transient`
  - 按 `retry.max_attempts` + `max_total_ms` 重试，必要时切换 Key
  - 暴露 `releaseUpstreamResponse` / `markUpstreamResponseStreamError` 给路由层在响应完成或流式中断时回调
- **`http-headers.ts`** 黑名单剥离 hop-by-hop 头与代理无意义头，保留 Claude Code/Anthropic SDK 依赖的私有头。

### 3.7 流式响应处理 (`passthrough.ts`、`stream-bridge.ts`、`stream-read.ts`、`response-fix.ts`)

- **`stream-read.ts`** 提供 `readStreamChunk`，将 reader 读取与 idle 超时 + client abort 组合。
- **`passthrough.ts`** 处理 Anthropic 路径下的多种响应：
  - peek 前 16KB 判别 SSE 类型（OpenAI / Anthropic / 其他）
  - 命中 OpenAI SSE → 缓冲转换为 Anthropic SSE（`response-fix.ts::transformOpenAISSEToAnthropicSSE`）
  - 命中 Anthropic SSE → 通过 `StreamingAnthropicSSEFixer` 状态机修复 id、usage、缺失事件
  - 其他 → 原样透传
- **`stream-bridge.ts`** 用于 openai_compatible → Anthropic 的流式桥接：在 reader 上逐 chunk 构造 Anthropic 协议事件（message_start / content_block_* / message_delta / message_stop）。
- **`response-fix.ts`** 是核心修复状态机，主要解决 oneapi 等网关吐出的"半成品 Anthropic SSE"。

### 3.8 鉴权 (`auth.ts`)

- **代理鉴权**：从 `Authorization` 或 `x-api-key` 取 token，与 `runtime_models.json` 配置的 `proxy_auth_token` 对比。
- **管理后台鉴权**：基于 cookie 校验 `ADMIN_AUTH_TOKEN`，由 `config.ts` 在首次启动时生成。

### 3.9 日志与诊断 (`utils/logger.ts`、`utils/pid.ts`)

- **`logger.ts`** 支持 json / text 两种格式、按天/按大小轮转、保留请求体响应体的"详细模式"。
- **`pid.ts`** 写 PID 与 port 文件，`ccop status` / `ccop stop` 据此操作。

## 4. 关键数据流

### 4.1 Anthropic Messages 非流式

```
Client → /v1/messages
  → auth.proxyAuthHook
  → runtimeConfigManager.resolveModel(model)
       ↳ 路由查询 → provider + rotator
  → upstreamService.postMessages
       ↳ rotator.acquire (lease)
       ↳ fetch(anthropic api)
       ↳ rotator.release / markError
  → passthrough.sendAnthropicPassthroughResponse
       ↳ openai-json → anthropic-json 兜底
       ↳ ensureAnthropicJsonShape 补齐字段
  → reply.send
```

### 4.2 OpenAI 兼容 → Anthropic 流式桥接

```
Client → /v1/messages (anthropic 请求, openai 上游)
  → buildOpenAICompatiblePayload (转换 messages/tools)
  → upstreamService.postChatCompletions (streaming)
  → stream-bridge.bridgeOpenAIStreamToAnthropic
       ↳ iterate SSE
       ↳ 构造 message_start / content_block_* / message_stop
       ↳ release lease & record usage
  → reply.raw (PassThrough)
```

### 4.3 API Key 状态流转

```
markError / markRateLimited / markQuotaError
  → rotator 内 entry 状态变更
  → 触发 onChange(provider, key, patch)
  → runtime-config 写入 KeyStateStore (debounced)
  → admin 接口可见
```

## 5. 重构边界与原则

本仓库本轮重构遵循以下原则：

1. **保留 public API 与运行时行为**：函数签名、HTTP 路由、JSON 格式、日志关键字保持不变。
2. **按职责拆分大文件**：超过 ~400 行且职责混合的文件优先拆分。
3. **预留抽象**：为存储层、错误分类等可能演化的部分预留接口，便于后续替换实现。
4. **死代码先标注后删除**：仅删除完全无引用的兼容层。
5. **每个模块独立提交**：commit message 使用中文，描述对哪个模块做了什么。

## 6. 已知后续改进方向

- 接入 SQLite + WAL 或其他集中式状态存储后，再开放多 Worker 集群。
- `logger.ts` 全局可变状态较多，未来可抽成实例化的 `Logger`，让测试更容易隔离。
- `runtime-config.ts` 中 Key CRUD 接口较多，可考虑独立成 `KeyAdminService`。
- `response-fix.ts` 修复状态机较复杂，建议补充单元测试覆盖各分支。
