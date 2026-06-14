# 功能详解（FEATURES）

本文档面向"想理解代理内部到底在做什么"的读者，按功能维度梳理代码里实现的所有重要策略。如果你只想看模块划分，请看 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

> 当前仓库版本：0.4.1，分支 `refactor/modular-cleanup`。

## 目录

1. [API 透传机制](#1-api-透传机制)
2. [Anthropic ↔ OpenAI 协议转换](#2-anthropic--openai-协议转换)
3. [SSE 流式响应处理](#3-sse-流式响应处理)
4. [SSE 修复状态机](#4-sse-修复状态机)
5. [API Key 轮询策略](#5-api-key-轮询策略)
6. [防封策略](#6-防封策略)
7. [API Key 自动禁用策略](#7-api-key-自动禁用策略)
8. [上游错误分类](#8-上游错误分类)
9. [本地配额守护](#9-本地配额守护)
10. [健康度评分](#10-健康度评分)
11. [重试策略](#11-重试策略)
12. [运行态持久化](#12-运行态持久化)
13. [集群模式](#13-集群模式)
14. [日志与诊断](#14-日志与诊断)
15. [鉴权](#15-鉴权)

---

## 1. API 透传机制

### 1.1 外部接口

| 路径 | 形态 | 入口 |
|---|---|---|
| `POST /v1/messages` | Anthropic Messages 协议 | `routes/messages.ts` |
| `POST /v1/messages/count_tokens` | Anthropic Token 统计 | `routes/messages.ts` |
| `POST /v1/chat/completions` | OpenAI Chat Completions 协议 | `routes/chat-completions.ts` |
| `GET /v1/models` | 模型列表 | `routes/messages.ts` |

### 1.2 透传策略

代理对**请求**采用 **黑名单剥离**而非白名单复制（`services/http-headers.ts`）：

- 删除的请求头：所有 hop-by-hop 头（connection、keep-alive、transfer-encoding 等）+ `host` + `content-length`
- 保留的请求头：客户端的 `anthropic-version`、`anthropic-beta`、`x-api-key`、`x-claude-code-session-id` 以及所有供应商私有头
- 注入的头：`x-request-id`、`x-claude-code-session-id`（仅当客户端未带）、provider 配置的固定头、根据 `provider_type` 自动选择 `Authorization: Bearer` 或 `x-api-key`

**为什么黑名单**：Claude Code / Anthropic SDK 会带很多供应商私有的实验头，白名单会误删；黑名单只剔除会破坏 hop 语义的头。

### 1.3 响应透传

响应头：删除 hop-by-hop 头 + `content-length` + `content-encoding`。

> `content-encoding` 必须删：fetch 已经把上游响应解压成裸字节交给应用层，再转发压缩头客户端会二次解压失败。

### 1.4 上游入口路径选择

根据 `provider.provider_type`：

- `openai_compatible`：拼接 `{base_url}/chat/completions`
- `anthropic`：先规范化 `base_url`（如果用户已加 `/v1` 则保留），再拼 `/messages` 或 `/messages/count_tokens`

> `base_url` 形如 `https://api.example.com/v1` 或 `https://api.example.com`，代码会自动判断是否需要补 `/v1`，避免拼成 `/v1/v1`。

### 1.5 透传四种响应形态

`/v1/messages` 收到的上游响应可能有四种形态（`services/passthrough.ts::pipeAnthropicSseWithRepair`）：

| 形态 | 判定方式 | 处理方式 |
|---|---|---|
| OpenAI SSE | peek 前 16KB 含 `"object":"chat.completion.chunk"` 等标记 | 缓冲全量后转换为 Anthropic SSE |
| Anthropic SSE | peek 含 `event: message_start` 或 `"type":"message_start"` | 走 `StreamingAnthropicSSEFixer` 增量修复 |
| 半成品 Anthropic SSE | 既有 Anthropic 帧结构又含 `chatcmpl-` id | 走修复器统一处理 |
| 其他/原始 | 都不匹配 | 原样转发 bytes |

---

## 2. Anthropic ↔ OpenAI 协议转换

### 2.1 请求转换（Anthropic → OpenAI）

`services/transformers.ts::anthropicToOpenAIMessages`：

- **system 字段**：字符串直接当 system message；数组中只取 `type=text` 的块拼接
- **assistant 消息**：拆分 `text` 块和 `tool_use` 块
  - `text` → `content`
  - `tool_use` → `tool_calls[]`，`function.arguments` 用 `JSON.stringify(input)`
- **user 消息**：
  - 普通块 → 拼接为 `content` 字符串
  - `tool_result` 块 → 单独的 `role: tool` 消息，`tool_call_id` 取自 `tool_use_id`
- **tools 字段**：`anthropicToolsToOpenAI` 转成 `{type:'function', function:{...}}`

### 2.2 响应转换（OpenAI → Anthropic 非流式）

`services/transformers.ts::openAIToAnthropicResponse`：

- `choices[0].message.content` → `content[0] = {type:'text', text}`
- `choices[0].message.tool_calls[]` → `content[1..] = {type:'tool_use', id, name, input}`，`arguments` 用 `JSON.parse` 还原；解析失败时降级为 `{raw: 原始字符串}`
- `finish_reason` 映射为 Anthropic `stop_reason`：
  - `stop` → `end_turn`
  - `length` → `max_tokens`
  - `tool_calls` / `function_call` → `tool_use`
  - `content_filter` → `refusal`
- **id 修复**：`chatcmpl-` 开头的 id 替换为 `msg_<hex>`（Claude Code 严格校验 id 格式）
- **usage 补齐**：Anthropic 必填的 `cache_creation_input_tokens` / `cache_read_input_tokens` 补 0，`server_tool_use` 补 null；`output_tokens` 至少为 1（Anthropic schema 不接受 0）

### 2.3 流式桥接（OpenAI SSE → Anthropic SSE）

`services/stream-bridge.ts::bridgeOpenAIStreamToAnthropic`：

```
↓ 写入 message_start（带补齐的 usage 5 字段）
逐 chunk 处理 OpenAI SSE：
  ├── 首次出现 delta.content
  │     └── 写入 content_block_start (type=text, index=0)
  │     └── 写入 content_block_delta (text_delta)
  │   后续 content delta
  │     └── 仅写入 content_block_delta
  ├── delta.tool_calls[i]
  │     ├── 首次出现 → content_block_start (type=tool_use)
  │     ├── arguments 增量 → content_block_delta (input_json_delta, partial_json)
  ├── 累积 usage.prompt_tokens / completion_tokens
  └── finish_reason → 映射 stop_reason，记录到 state
↓ 流结束：依序关闭所有 content_block_stop
↓ message_delta (含 usage、stop_reason)
↓ message_stop
```

关键细节：
- **content block index 分配**：从 0 开始，先文本后工具，依出现顺序连续编号
- **异常时也要补 message_stop**：已经发出 `message_start` 后，无论中途何种错误都必须用 `closeAnthropicMessage` 收尾，否则 Claude Code 会一直等未闭合 block
- **客户端断开**：通过 `clientAbortSignal` 提前退出，不再 release lease 之外的副作用

---

## 3. SSE 流式响应处理

### 3.1 读取超时控制

`services/stream-read.ts::readStreamChunk`：

```
race(
  reader.read(),                    // 正常读
  setTimeout(idleTimeoutMs),        // idle 超时
  clientAbortSignal.abort 事件      // 客户端断开
)
```

- 上游一段时间没数据 → 抛 `Error('SSE idle timeout: Nms')`
- 客户端断开 → 抛 `StreamClientAbortError`

> 之所以要监听 abort 事件：reader 一旦 `getReader()` 锁定 body，路由层就没法 cancel；必须让持有 reader 的代码自己感知断开。

### 3.2 idle 超时来源

来自 `provider.stream_idle_timeout_seconds`（默认 120s），保底为环境变量 `REQUEST_STREAM_IDLE_TIMEOUT_MS`。

### 3.3 客户端断开传播

`reply.raw.once('close', onClientClose)`：

```
onClientClose:
  clientClosed = true
  clientAbort.abort()         → readStreamChunk 立刻退出
  output.destroy()            → PassThrough 立刻结束
```

之后流式桥接 / SSE 修复都会通过 `isClientClosed()` 提前 return，不再写日志、不再 markError。

### 3.4 peek + restore 技巧

`passthrough.ts::peekAndRestore`：

- 取 reader 读前 16KB 用来判别 SSE 类型
- 再用 `ReadableStream` 把"已读片段 + 剩余片段"重新拼成一个新的 Response
- peek 阶段如果遇到上游已断流，仍把已读到的 Anthropic 头部交给修复器，让它能补出 `message_stop`，比直接吐 error 给客户端友好

---

## 4. SSE 修复状态机

`services/response-fix.ts::StreamingAnthropicSSEFixer` 是项目里最复杂的一块。它修复的是上游（典型如 oneapi 网关）返回的"半成品 Anthropic SSE"。

### 4.1 修复点清单

| 修复点 | 触发 | 处理 |
|---|---|---|
| **id 替换** | 任意事件 JSON 含 `id: chatcmpl-...` | 替换为 `msg_<hex>` |
| **message_start.usage 补齐** | 缺 5 个 usage 字段 | 补 `input_tokens=0` / `cache_*=0` / `output_tokens=1` / `server_tool_use=null` |
| **message_start.message 补齐** | 缺 `id` / `type` / `role` / `content` / `stop_*` | 全部补默认值 |
| **content block index 重编号** | 上游索引乱序或跳号 | 按出现顺序 remap 为 0,1,2,... |
| **thinking 块丢弃** | `content_block_start.content_block.type === 'thinking'` / `redacted_thinking` | 默认整段丢弃（include start/delta/stop）|
| **未知 content block 丢弃** | type 不是 text/tool_use/thinking | 整段丢弃 |
| **text 块缺 text 字段** | `content_block_start` 含 type=text 但缺 text | 补 `text: ''` |
| **tool_use 块缺 id/name/input** | 同上 | 自动生成 `toolu_<hex>` / 补空字符串 / 补 `{}` |
| **content_block_delta 类型校正** | `thinking_delta` 但保留 thinking 块时 | 改为 `text_delta` |
| **message_delta.usage.output_tokens** | 缺字段 | 补 0 |
| **缺收尾事件** | 流结束时没见到 `content_block_stop` / `message_delta` / `message_stop` | `finalize()` 时按状态机依次补齐 |

### 4.2 状态机内部

```
sawMessageStart      ─ 见过 message_start
sawMessageDelta      ─ 见过 message_delta
sawMessageStop       ─ 见过 message_stop
openedIndices        ─ 已开启的（重编号后的）block index 列表
closedIndices        ─ 已 content_block_stop 的 block index 集合
remap                ─ 原始 index → 新 index 的映射
thinkingIndices      ─ 标记为 thinking 的（原始）index
droppedBlockIndices  ─ 整段丢弃的 block（thinking / 未知类型）
```

### 4.3 流式分块处理

`push(chunk)` 接受任意分块（可能在事件中间断开）：
- 内部维护一个跨调用的 `buffer`，只在见到完整空行时 flush
- 每个 flush 出来的 event 走 `processEvent` 修复
- `finalize()` 在流结束时调用，把未关闭的 block / 缺失的 message_stop 补齐

---

## 5. API Key 轮询策略

### 5.1 两种选择器

`services/key-selectors.ts`：

**Sticky（粘性）**
- 一旦选中一个 Key，后续请求都用它
- Key 被标记不可用（`notifyKeyUnavailable`）才切换
- 选择新 Key 时按健康分最高优先
- **适合错误概率低的场景**：减少 cold start、保持上下文亲和性

**Balanced（加权随机）**
- 每次请求按健康分加权随机选择
- 健康分有下限 `min_weight`（默认 0.05），避免完全冷藏的 Key 永远轮不到
- **适合错误概率高的场景**：分散风险，自动绕开有问题的 Key

### 5.2 选择器选择规则

```
if anti_ban.key_selection == 'balanced':  Balanced
elif anti_ban.key_selection == 'sticky':  Sticky
else:
  if strategy == round_robin:             Balanced
  else (on_429):                          Sticky
```

### 5.3 可用性筛选

`api-key-rotator.ts::eligibleKeys` 每次选择前过滤：

- `entry.enabled === false` → 排除
- `quotaGuard.isBlocked(key)` → 排除（本地配额触发）
- `state.activeRequests >= max_concurrent` → 排除（并发上限）
- `state.nextAvailableAt > now` → 排除（在 429 冷却期内）
- `state.lastSentAt + min_interval_ms > now` → 排除（最小间隔节流）

### 5.4 Sticky on cooldown

当 sticky 选中的 Key 进入冷却期，有两种选择：

- `wait`（等待）：阻塞 acquire，直到 nextAvailableAt 到达
- `fallthrough`（穿透，默认）：立刻切换到其他健康 Key

---

## 6. 防封策略

### 6.1 默认参数（conservative 模式）

`services/anti-ban-config.ts::ANTI_BAN_DEFAULTS`：

| 参数 | 默认值 | 含义 |
|---|---|---|
| `max_concurrent` | 1 | 单 Key 同时在飞请求数上限 |
| `min_interval_ms` | 1000 | 同一 Key 两次请求最小间隔（节流） |
| `rate_limit_delay_min_ms` | 5000 | 收到 429 后冷却时长下界 |
| `rate_limit_delay_max_ms` | 10000 | 收到 429 后冷却时长上界（随机） |
| `key_selection` | sticky | 选择器类型 |
| `sticky_on_cooldown` | fallthrough | sticky Key 冷却时的处理 |

### 6.2 throughput 模式

- `max_concurrent=3`
- `min_interval_ms=100`
- `rate_limit_delay_min_ms=1000`、`max=3000`

适合对外暴露的"按量计费、限速宽松"的供应商。

### 6.3 配置层级（从低到高覆盖）

1. `ANTI_BAN_DEFAULTS`
2. 全局 `runtime_models.json::anti_ban`
3. provider 级 `anti_ban`
4. 模式 preset（`conservative` / `throughput`）

如果 provider 没显式覆盖某字段，回落到全局；全局没设回落到 preset；最终都没设回落到 DEFAULTS。

### 6.4 lease 泄漏清理

`api-key-rotator.ts` 设计上每个 acquire 必须对应一次 release。但流式请求异常时可能漏掉 release，导致 `activeRequests` 永远递增、Key 看起来"满载不可用"。

防护：每次筛选可用 Key 前 `sweepLeakedLeases`：

- 维护每个进行中 lease 的开始时间数组
- 超过 `LEASE_MAX_AGE_MS = 10 分钟` 的 lease 强制清掉
- 默认 10 分钟覆盖最长正常流式请求；过短会误杀慢请求，过长会让真正泄漏的 lease 卡住更久

### 6.5 429 冷却幂等

429 重试时不会无限延后冷却：`markRateLimited` 只在 `nextAvailableAt == null || nextAvailableAt <= now` 时才设置新冷却时间，否则保留已有 deadline。

> 否则连续 429 会让冷却结束时间一直被推后，肉眼看就是"这个 Key 永远不恢复"。

---

## 7. API Key 自动禁用策略

### 7.1 触发条件

**累计错误数禁用**（`markError`）：

```
if settings.keyAutoDisable               // 全局 env: KEY_AUTO_DISABLE
   and provider.auto_disable_on_error    // provider 级 auto_disable_on_error
   and entry.error_count + 1 >= settings.keyMaxErrors  // 阈值
   and entry.enabled:                    // 当前还启用
   entry.enabled = false
   entry.auto_disabled_at = now()
```

阈值优先级：`runtime_models.json::key_max_errors` > 环境变量 `KEY_MAX_ERRORS`（默认 5）。

**硬限制立即禁用**（`markQuotaError`）：

- 上游错误归类为 `hard_limit`（额度耗尽 / 无效 key / 账号封禁），不再走累计计数，**直接禁用**

### 7.2 计数清零

`markSuccess`：

- 成功一次就把 `error_count` 清零、`last_error_*` 清空
- 但**不自动启用**已被禁用的 Key（用户操作或 `resetErrorCount` 才会）

### 7.3 重置渠道

| 操作 | 入口 | 行为 |
|---|---|---|
| 手动启用 | Admin → `PUT /api/keys/:p/:i/enable` | enabled=true、清错误计数与冷却 |
| 手动禁用 | Admin → `PUT /api/keys/:p/:i/disable` | enabled=false |
| 重置单 Key | Admin → `PUT /api/keys/:p/:i/reset` | 清错误计数 + 清配额计数 + 重置健康分（运行态）+ 启用 |
| 重置所有 | Admin → `PUT /api/keys/:p/reset-all` | 对 provider 下所有 Key 重置 |

### 7.4 多 provider 错误隔离

错误计数按 `(provider_id, key_id)` 隔离，不同 provider 用相同 key 字面量互不影响。

---

## 8. 上游错误分类

`services/upstream.ts::classifyUpstreamError` 把上游 4xx/5xx 响应归为 4 类：

### 8.1 `hard_limit`（硬限制）

**关键词命中**：`quota` / `insufficient_quota` / `billing hard limit` / `invalid api key` / `account banned` / `账号封禁` / `余额不足` 等。

**状态码命中**：`401` / `403`。

**处理**：
- 单 Key 时直接返回错误给客户端
- 多 Key 时调用 `markQuotaError` 立即禁用当前 Key，切换到下一个继续重试
- **优先级最高**：必须最先判，避免 `token limit` 这种含 limit 字样的错误抢先归类为 transient

### 8.2 `request_limit`（请求过长）

**关键词命中**：`token-limit` / `context length` / `maximum context length` / `请求 token 过长` / `上下文长度` 等。

**处理**：直接返回客户端，**不重试不切换 Key**（换 Key 也是同样的请求长度问题，只会白白消耗配额）。

### 8.3 `rate_limit`（限流）

**关键词命中**：`rate limit` / `too many requests` / `限流` / `请求过多` 等。

**状态码命中**：`429`。

**处理**：
- `markRateLimited` 设置冷却时间
- 如果 `retry.retry_on_rate_limit=true`，重试（切换 Key 或等待）
- 否则返回客户端

### 8.4 `transient`（瞬时错误）

兜底分类。

**处理**：
- `markError` 累计错误计数（可能触发自动禁用）
- 如果 `retry.retry_on_transient=true`，重试
- 否则返回客户端

### 8.5 错误关键词更新原则

新增供应商时，错误响应里的中文关键词建议加入 `hardLimit` / `rateLimit` 数组。代码在 `upstream.ts::classifyUpstreamError`。

---

## 9. 本地配额守护

`services/quota-guard.ts::QuotaGuard` 用于在上游真正返回硬限制前主动停用 Key。

### 9.1 配额配置

每个 Key 可配 `quota`：

```json
{
  "max_requests": 1000,
  "max_tokens": 1000000,
  "soft_stop_threshold": 0.95
}
```

- `max_requests` / `max_tokens` 任一为 null 表示该维度不限
- `soft_stop_threshold` 默认 0.95：使用率达到 95% 就软停用

### 9.2 配额继承

`undefined` 表示继承 provider 默认 quota；`null` 表示该 Key 显式不使用配额（即使 provider 配了 quota）。

### 9.3 触发与展示

当 `requests_used >= max_requests * threshold` 或 `tokens_used >= max_tokens * threshold`：

- `isBlocked(key) === true`，选择器筛选时排除
- `lastBlockReason(key)` 返回 `'本地请求配额接近上限'` 或 `'本地 token 配额接近上限'`
- Admin 接口可见 `quota_blocked: true`、`quota_reason`

### 9.4 计数来源

`recordUsage(key, requests, tokens)` 在每次响应完成时被调用：

- 非流式：`routes` 解析 `usage.total_tokens` 后调用
- 流式：`stream-bridge` 累积 `usage.prompt_tokens + completion_tokens` 后调用
- Anthropic 透传：用 `input_tokens + output_tokens`

### 9.5 持久化触发

`UsageStore` 的双触发刷盘：

- **批次阈值**：累计 `persist_every_n_requests` 次更新就写盘（默认 50）
- **临界值**：使用率 >= `persist_critical_threshold` 立刻写盘（默认 0.85）

> 这样平时积攒批量写、接近耗尽时立刻持久化，避免崩溃后丢失关键边界状态。

---

## 10. 健康度评分

`services/health-tracker.ts::HealthTracker` 给每个 Key 算 `[0.1, 1.05]` 范围的健康分。

### 10.1 滑动窗口

每个 Key 维护三个事件列表（rate_limit / transient / success），窗口长度 `window_ms` 默认 300000ms（5 分钟）。

窗口外的事件懒清理：每次查询时弹出过期项。

### 10.2 评分公式

```
rl_score   = max(rate_limit_penalty_floor,
                  1 - rate_limit_penalty_per_event × rl_count)
tr_score   = max(transient_penalty_floor,
                  1 - transient_penalty_per_event × tr_count)
cn_score   = max(consecutive_penalty_floor,
                  1 - consecutive_penalty_per_event × max(0, consecutive_errors - 1))
fresh      = fresh_success_boost if (now - lastSuccessAt) <= fresh_success_window_ms else 1.0

raw_score  = rl_score × tr_score × cn_score × fresh
final      = clamp(raw_score, score_floor, score_ceiling)
```

### 10.3 关键参数（默认）

| 参数 | 默认值 | 作用 |
|---|---|---|
| `window_ms` | 300000 | 滑动窗口（5min）|
| `rate_limit_penalty_per_event` | 0.15 | 每次 429 扣 15% |
| `rate_limit_penalty_floor` | 0.2 | 429 惩罚下限 |
| `transient_penalty_per_event` | 0.10 | 每次瞬时错误扣 10% |
| `transient_penalty_floor` | 0.3 | 瞬时惩罚下限 |
| `consecutive_penalty_per_event` | 0.20 | 连续错误每次扣 20% |
| `consecutive_penalty_floor` | 0.1 | 连续错误惩罚下限 |
| `fresh_success_boost` | 1.05 | 近期成功加成 |
| `fresh_success_window_ms` | 60000 | "近期"定义为 1 分钟内 |
| `score_floor` / `ceiling` | 0.1 / 1.05 | 健康分硬截断 |

### 10.4 使用方
- Sticky 选择器：分数最高者
- Balanced 选择器：分数作为权重，加权随机
- Admin 显示：每个 Key 的实时健康分 + 近期事件计数

---

## 11. 重试策略

`services/upstream.ts::postToUpstream` 在 4 类错误下决定是否重试。

### 11.1 重试参数

| 字段 | 默认值 | 含义 |
|---|---|---|
| `retry.max_attempts` | 3 | 最大尝试次数（含首次） |
| `retry.max_total_ms` | 30000 | 总耗时上限 |
| `retry.retry_on_rate_limit` | true | 429 是否重试 |
| `retry.retry_on_transient` | true | 5xx / 网络错误是否重试 |

### 11.2 重试矩阵

| 错误类型 | 行为 |
|---|---|
| `hard_limit` 且有 rotator | 切换下一个 Key 继续 |
| `hard_limit` 且无 rotator | 直接返回 |
| `request_limit` | 直接返回（换 Key 也是同样问题） |
| `rate_limit` 且 `retry_on_rate_limit=false` | 直接返回 |
| `rate_limit` 且 `retry_on_rate_limit=true` | 继续循环（选下一个健康 Key） |
| `transient` 且 `retry_on_transient=false` | 直接返回 |
| `transient` 且 `retry_on_transient=true` | 继续循环 |
| `network error` (fetch 抛错) | 同 transient |
| 等待 Key 超时 (`等待可用 API Key 超时`) | 返回上次响应或 503 |

### 11.3 截断条件

每次循环开头检查：
- 已尝试次数 >= `max_attempts`
- `Date.now() >= deadline`（首次 acquire 时设置）
- `rotator.hasAvailableKey() === false`

满足任一即返回 `lastResponse` 或 502。

### 11.4 流式与重试

流式请求 `timeoutMs = undefined`（不设单次 fetch 超时，依赖 idle 超时）。

流式响应一旦 `response.ok === true`，重试机制即结束；后续的流中断只能通过 `markUpstreamResponseStreamError` 回写 Key 健康状态，不能再换 Key 重发。

---

## 12. 运行态持久化

### 12.1 三个文件分工

| 文件 | 内容 | 写入方 |
|---|---|---|
| `runtime_models.json` | 用户配置（providers / models / api_key 用户字段） | Admin 编辑 / 启动时补 id |
| `runtime_state.json` | Key 运行态（error_count / disabled_at / last_error_* / auto_disabled_at / 自动禁用后的 enabled） | `KeyStateStore` |
| `runtime_usage.json` | Key 累计计数（requests_used / tokens_used） | `UsageStore` |

### 12.2 主键策略

主键格式 `${providerId}:${keyId}`：

- `keyId` 是 nanoid（Crockford base32，10 字符）
- 一旦生成不变；用户改 key 字面量也保留历史
- v1 → v2 升级时（v2 改用 id 主键），旧格式直接当空对象处理，相当于一次"用户选择全部重置"

### 12.3 atomic 写入

`utils/atomic-write.ts::writeJsonAtomic`：
- 写 `.tmp` → `rename` 到目标
- rename 在 POSIX 是原子操作；Windows 也基本原子
- 避免崩溃时半写

### 12.4 写盘节流

**KeyStateStore**：
- debounce 500ms（写多读少场景的轻量化）
- forceFlush：Admin 操作或关键状态变更时立即刷盘

**UsageStore**：
- 双触发：批次阈值 + 临界值
- 串行化：所有写操作通过 promise 链排队，避免多 writer 抢同一个 `.tmp`

### 12.5 reconcile（一致性对齐）

启动 / `saveConfig` / `addKey` 时调用：
- 当前 config 中没有的 key → 从 store 删除
- 当前 config 中新增的 key → store 补默认零值
- 保证 state/usage 文件总是反映当前 config 的全量 key 集合

### 12.6 计划：ConfigRepository 抽象层

未来若引入 SQLite：

```
interface ConfigRepository {
  loadConfig(): Promise<RuntimeConfig>
  saveConfig(config): Promise<void>
  loadKeyStates(): Promise<Record<string, KeyRuntimeRecord>>
  patchKeyState(compositeKey, patch): Promise<void>
  loadUsages(): Promise<Record<string, KeyUsage>>
  updateUsage(compositeKey, usage): Promise<void>
}
```

当前 JSON 实现是默认实现；切 SQLite 只新增一份实现，其他模块不动。

---

## 13. 集群模式

`src/cluster.ts`：

### 13.1 启动

`ccop start -c [workers]`：
- workers 不指定时取 `CLUSTER_WORKERS` 或 `os.cpus().length`
- 主进程 fork N 个 worker，每个跑完整的 `startServer`

### 13.2 worker 回收

- worker 异常退出 → master 立刻 `cluster.fork()` 补一个
- 收到 SIGINT/SIGTERM → `disconnect` 所有 worker，10 秒后强制 kill

### 13.3 已知限制

当前 worker 之间**不共享 Key 状态**：
- 每个 worker 内存里有独立的 `ApiKeyRotator`
- worker A 标记 Key 冷却 5 秒，worker B 不感知
- 状态持久化文件存在多 writer 竞争风险

未来方案：迁移到 SQLite（详见 ConfigRepository 抽象）。

---

## 14. 日志与诊断

`utils/logger.ts`：

### 14.1 双格式

- `LOG_FORMAT=json`（默认）：每行一条 JSON，便于日志聚合
- `LOG_FORMAT=text`：人类可读

### 14.2 详细模式

`LOG_DETAILED=true` 时记录 `request_body` / `response_body` / `request` / `response` 字段；默认关闭。

### 14.3 轮转

`LOG_ROTATION`：
- `none`：不轮转
- `daily`（默认）：按北京时区每日 rename 为 `app-YYYY-MM-DD.log`
- `size`：超过 `LOG_MAX_SIZE`（默认 50MB）轮转

`LOG_MAX_FILES`（默认 30）：保留最旧文件被自动 unlink。

### 14.4 时区

所有日志时间戳用 `Asia/Shanghai`（`utils/time.ts`），便于 PRC 用户排障。

### 14.5 异步写不阻塞

每条日志的 file write 是异步 promise，不 await；定期清理已完成的 promise 避免数组无限增长。

`flushLogs()` 在退出信号时调用，确保关键日志落盘。

---

## 15. 鉴权

`src/auth.ts`：

### 15.1 代理鉴权（外部调用）

- 读取 `Authorization: Bearer <token>` 或 `x-api-key`
- 与 `runtime_models.json::proxy_auth_token` 对比
- 配置为空时**允许匿名访问**（私网部署常用）

### 15.2 管理后台鉴权

- cookie 名 `ccgp_admin_session`，maxAge 12 小时
- 与 `ADMIN_AUTH_TOKEN`（env）对比
- token 来源：
  - 首次启动自动生成 `ccop_<24字节 base64url>` 写入 `~/.ccop/.env`
  - 已有 `.env` 但缺 `ADMIN_AUTH_TOKEN` → 自动补齐随机值
  - 开发模式无 `.env` 时降级为 `admin123`
- 生产模式必须设置；缺失则拒绝启动

### 15.3 限流

`@fastify/rate-limit`：
- `RATE_LIMIT_MAX`（默认 100）
- `RATE_LIMIT_TIME_WINDOW`（默认 60000ms）
- 命中限流时返回 Anthropic 风格错误 JSON

---

## 附：常用调参速查

| 想做什么 | 改哪里 |
|---|---|
| 调整 Key 自动禁用阈值 | env `KEY_MAX_ERRORS` 或 config `key_max_errors` |
| 关闭 Key 自动禁用 | env `KEY_AUTO_DISABLE=false` 或 provider `auto_disable_on_error=false` |
| 调整 429 冷却时长 | `anti_ban.rate_limit_delay_min_ms` / `max_ms` |
| 调整最小请求间隔 | `anti_ban.min_interval_ms` |
| 切换为高吞吐模式 | `anti_ban.mode = "throughput"` |
| 平均分发到多 Key | `anti_ban.key_selection = "balanced"` |
| 限制单 Key 日额度 | per-key `quota.max_requests` / `max_tokens` |
| 关闭 thinking 块透传 | `StreamingAnthropicSSEFixer({ dropThinking: false })` 改源码（暂未暴露配置） |
| 强制上游 identity 编码 | env `FORCE_IDENTITY_ACCEPT_ENCODING=true` |
| 提升流式 idle 容忍 | provider `stream_idle_timeout_seconds` |
| 上游连接池大小 | env `MAX_SOCKETS` |
