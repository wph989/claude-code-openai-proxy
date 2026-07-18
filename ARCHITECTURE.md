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
  models.ts           # 历史兼容导出入口
  types/runtime-config.ts  # 运行时配置纯类型
  routes/
    health.ts         # GET /livez、/readyz、/healthz、/metrics
    admin.ts          # 管理后台静态资源与 REST API
    chat-completions.ts  # POST /v1/chat/completions
    messages.ts          # POST /v1/messages、count_tokens、GET /v1/models
  services/
    runtime-config.ts # 运行时配置管理器（核心协调者）
    admin-config.ts   # 管理 DTO 脱敏、秘密合并与变更预览
    admin-event-stream.ts # 管理端有界 SSE 事件流
    provider-connectivity.ts # Provider 无生成成本连接探测
    provider-health.ts # Provider 熔断与单半开探测
    routing-policy.ts  # 模型路由优先级与加权策略
    config/
      repository.ts  # 配置/状态/用量存储端口
      json-file-repository.ts # JSON 原子持久化适配器
      normalizer.ts  # 配置标准化与校验
    upstream.ts       # 上游 HTTP 调用 + 错误分类 + 重试
    metrics.ts        # Prometheus 指标注册、聚合与渲染
    passthrough.ts    # SSE/JSON 响应透传与修复
    stream-bridge.ts  # OpenAI SSE → Anthropic SSE 桥接
    stream-read.ts    # 流式 reader 读取（超时 + abort）
    response-fix.ts   # SSE 修复/转换兼容导出门面
    response-fix/     # 协议检测、SSE codec 与 OpenAI 转换
    transformers.ts   # Anthropic ↔ OpenAI 协议消息互转
    http-headers.ts   # 请求/响应头白名单与转发策略
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
- **`server.ts`** 注册 cookie、rate-limit、错误处理、请求 ID 和 HTTP 指标钩子，并把 `RuntimeConfigManager` / `UpstreamService` / `MetricsRegistry` 装饰到 `FastifyInstance` 上供路由层使用。
- **`cluster.ts`** 在主进程 fork 单个 worker，处理子进程退出与优雅关闭；多 Worker 需先接入集中式状态存储。

### 3.2 路由层 (`routes/`)

| 路由 | 职责 |
|---|---|
| `health.ts` | 存活 `/livez`、就绪 `/readyz`、兼容 `/healthz` 与 Prometheus `/metrics` |
| `admin/events.ts` | 管理端 SSE 事件连接，按 Cookie 鉴权并从有界历史回放 |
| `admin/providers.ts` | Provider 主动连接测试动作 |
| `admin.ts`、`admin/` | 兼容注册门面；session、config 与 keys 子模块分别处理会话、资源配置和稳定 ID Key 管理 |
| `chat-completions.ts` | OpenAI 风格 `POST /v1/chat/completions`（仅支持 openai_compatible 上游） |
| `messages.ts` | Anthropic 风格 `POST /v1/messages`、`count_tokens`、`GET /v1/models` |

`messages.ts` 内部按上游类型分两条主线：
1. `provider_type === 'anthropic'` → 透传 + SSE 修复（`passthrough.ts`）
2. `provider_type === 'openai_compatible'` → 协议转换 + SSE 桥接（`transformers.ts` + `stream-bridge.ts`）

### 3.3 配置与数据模型 (`types/runtime-config.ts`、`services/config/`、`services/runtime-config.ts`)

- **`types/runtime-config.ts`** 只保存纯类型；`models.ts` 作为旧导入路径的兼容门面。
- **`services/config/normalizer.ts`** 统一执行 normalize、引用校验、稳定 ID 补全和运行态剥离。
- **`ConfigRepository`** 隔离配置、Key 状态与用量的物理存储；当前由 `JsonFileConfigRepository` 实现。
- **`services/runtime-config.ts`** 是核心协调者：
  - 加载/保存 `runtime_models.json`
  - 持久化运行态到 `runtime_state.json` / `runtime_usage.json`
  - 为每个 provider 维护一个 `ApiKeyRotator`
  - 过滤不可用 Provider/Key，并委托 `RoutingPolicy` 选择同名模型路由
  - 暴露 Key 的 CRUD（启用/禁用/重置/添加/删除/配额）
- **`services/admin-config.ts`** 构造 `AdminConfigView` / `AdminKeyView`：Key 只返回掩码，Token 只返回是否配置，敏感 Header 在服务端置空；保存时按稳定 ID 合并服务端秘密。
- **`services/admin-config-service.ts`** 承担全局设置、Provider 和模型路由的资源级写入；路由层只解析 HTTP 参数并映射响应。
- **`services/key-admin-service.ts`** 统一稳定 ID Key 的增删、启停、重置、备注、配额和主动导出，避免路由层直接操作运行时门面。
- **`services/admin-event-stream.ts`** 只承载管理面需要的低基数摘要，事件历史限制为 100 条，并拒绝把秘密、正文或查询参数放入事件。
- **`services/provider-connectivity.ts`** 按显式 Provider 类型选择认证头，通过 `GET /models` 做无生成成本探测；不复用生产 Key lease。
- **`services/routing-policy.ts`** 先选最小 `priority`，再按 `weight` 加权；随机源可注入，边界测试不依赖概率。
- **`services/provider-health.ts`** 维护进程内 closed/open/half-open 状态。探测 lease 带唯一 ID 和代际，避免旧并发请求误关新熔断。
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
- **`key-auto-recovery.ts`** 独立调度自动恢复计时器，避免运行时状态机与定时器生命周期继续耦合。
- **`key-selectors.ts`** 实现两种选择策略：sticky（咬住活跃 Key，失败后切换）/ balanced（在可用 Key 中随机）。
- **`quota-guard.ts`** 比较累计 usage 与 quota（max_requests / max_tokens / soft_stop_threshold），决定是否屏蔽。

### 3.5 持久化 (`key-state-store.ts`、`usage-store.ts`、`utils/atomic-write.ts`)

> **存储抽象现状**：state/usage/config 已通过 `ConfigRepository` 隔离；未来可新增 SQLite 适配器，但跨 Worker lease 仍需事务与 TTL 语义后才能开放。

- 三个文件都通过 `writeJsonAtomic` 写入（`writeFile` 到 `.tmp` → `rename`），避免半写状态。
- `KeyStateStore` 主键为 `${providerId}:${keyId}`，使用稳定的 nanoid，避免 Key 字面量变更丢失历史。
- 环境变量 Key 保存在不可序列化的运行时缓存中，稳定 ID 使用 `env:<变量名>`，不会被保存回 `runtime_models.json`。
- `UsageStore` 采用"批次阈值 + 临界值"双触发刷盘，平衡性能与一致性。

### 3.6 上游通讯 (`services/upstream.ts`、`services/providers/`、`services/http-headers.ts`)

- **`upstream.ts`** 封装 fetch（undici Agent）：
  - 自动加上鉴权头（OpenAI 用 `Authorization: Bearer`、Anthropic 用 `x-api-key`）
  - 错误分类 (`classifyUpstreamError`) → `hard_limit` / `rate_limit` / `request_limit` / `transient`
  - 按 `retry.max_attempts` + `max_total_ms` 重试，必要时切换 Key
  - 网络/5xx 回写 Provider 熔断；429/4xx 只影响 Key 或请求
  - 暴露 `releaseUpstreamResponse` / `markUpstreamResponseStreamError`，在响应真正消费完成后确认 Provider 成功，断流时记录失败
- **`services/providers/`** 按显式 `provider_type` 注册 `ProviderAdapter`，统一 URL、认证头与协议能力；禁止根据 URL、Key 或模型名隐式推断协议。
- **`http-headers.ts`** 黑名单剥离 hop-by-hop 头与代理无意义头，保留 Claude Code/Anthropic SDK 依赖的私有头。

### 3.7 流式响应处理 (`passthrough.ts`、`stream-bridge.ts`、`stream-read.ts`、`response-fix.ts`)

- **`stream-read.ts`** 提供 `readStreamChunk`，将 reader 读取与 idle 超时 + client abort 组合。
- **`passthrough.ts`** 处理 Anthropic 路径下的多种响应：
  - peek 前 16KB 判别 SSE 类型（OpenAI / Anthropic / 其他）
  - 命中 OpenAI SSE → 缓冲转换为 Anthropic SSE（`response-fix.ts::transformOpenAISSEToAnthropicSSE`）
  - 命中 Anthropic SSE → 通过 `StreamingAnthropicSSEFixer` 状态机修复 id、usage、缺失事件
  - 其他 → 原样透传
- **`stream-bridge.ts`** 用于 openai_compatible → Anthropic 的流式桥接：在 reader 上逐 chunk 构造 Anthropic 协议事件（message_start / content_block_* / message_delta / message_stop）。
- **`response-fix.ts`** 保留旧导入路径；协议检测、SSE codec、Anthropic 修复状态机和 OpenAI 转换位于 `services/response-fix/`。
- **`passthrough/sse-usage.ts`** 跨任意 UTF-8 chunk 边界提取 OpenAI/Anthropic 累计 usage，只保留数字并同时更新配额和指标。

### 3.8 鉴权 (`auth.ts`)

- **代理鉴权**：从 `Authorization` 或 `x-api-key` 取 token，与 `runtime_models.json` 配置的 `proxy_auth_token` 对比。
- **管理后台鉴权**：基于 cookie 校验 `ADMIN_AUTH_TOKEN`，由 `config.ts` 在首次启动时生成。
- **管理面秘密边界**：普通查询不下发完整 Key/Token；完整 Key 仅由管理员主动访问导出端点取得，导出事件只记录 provider 与数量。

### 3.9 管理配置并发

- 配置持有单调递增 `revision`，`GET /api/config` 以 `ETag` 返回。
- 完整配置兼容写入、资源级 Provider/路由/设置写入、预览与 Token 轮换均要求 `If-Match`；旧版本返回 `409`，缺失前置条件返回 `428`。
- 管理 UI 使用服务端字段级变更摘要，浏览器不再持有或展示原始配置 JSON。

### 3.10 日志与诊断 (`utils/logger.ts`、`utils/pid.ts`)

- **`logger.ts`** 保留全局兼容 API，核心 `Logger` 可实例化注入；支持 json / text、按天/按大小轮转和请求体响应体"详细模式"。
- **`pid.ts`** 写 PID 与 port 文件，`ccop status` / `ccop stop` 据此操作。

### 3.11 健康检查与指标 (`routes/health.ts`、`services/metrics.ts`)

- `/livez` 只表示进程存活；`/readyz` 在运行时配置初始化完成前返回 503；`/healthz` 保留兼容行为。
- `/metrics` 输出 Prometheus 文本，覆盖 HTTP 请求量、延迟、TTFB、活跃请求、上游错误/重试和 usage Token。
- 标签限制为路由模板、状态类别和 `provider_type` 等低基数字段，禁止 Key、模型名、查询参数、请求 ID 和正文进入指标。

管理事件同样只传输 Provider ID、稳定 Key ID、配额数字、状态码和耗时摘要；`GET /api/admin/events` 支持 `Last-Event-ID`，客户端由 EventSource 自动重连。

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

1. **兼容迁移**：旧 Key 索引 URL 保留一个周期并返回 `Deprecation: true`；新写入统一使用稳定 ID 与 revision。
2. **按职责拆分大文件**：超过 ~400 行且职责混合的文件优先拆分。
3. **预留抽象**：为存储层、错误分类等可能演化的部分预留接口，便于后续替换实现。
4. **死代码先标注后删除**：仅删除完全无引用的兼容层。
5. **每个模块独立提交**：commit message 使用中文，描述对哪个模块做了什么。

## 6. 已知后续改进方向

- 接入 SQLite + WAL 或其他集中式状态存储后，再开放多 Worker 集群。
- 跨 Provider 重试需先定义幂等键透传与重复计费边界；当前只对后续请求执行健康故障转移。
- 配置历史/回滚、费用预算、Webhook 告警和 Responses API 按产品需求逐项引入。
