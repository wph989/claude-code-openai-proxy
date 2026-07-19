# 系统架构与运行机制

## 系统定位

CCOP 是 Node.js 22.5+、TypeScript ESM 和 Fastify 实现的单进程或多 Worker AI 代理。它同时提供 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses 协议，并由桌面浏览器 Web 管理端维护运行配置。项目不包含 Electron、Tauri 或移动端客户端。

## 模块边界

```text
src/
  cli.ts, cluster.ts        CLI、守护进程与 Worker 生命周期
  server.ts                 Fastify 组装、钩子与关闭流程
  routes/                   公开协议、健康检查与管理 API
  services/
    runtime-config.ts       配置加载、热刷新与应用协调
    routing-policy.ts       priority + weight 路由选择
    api-key-rotator.ts      Key 获取、冷却、失败和用量处理
    upstream.ts             上游请求、错误分类与重试
    providers/              Provider 类型与能力矩阵
    response-fix/           SSE 解析、检测、修复与转换
    config/                 SQLite 仓储、迁移和共享协调器
  static/                   原生 ESM 桌面浏览器管理端
  types/                    运行时配置与协议类型
tests/                      Vitest 回归测试
```

依赖方向为 `Routes -> Application Services -> Policies/Ports -> SQLite/HTTP Adapters`。路由层只做鉴权、参数解析和响应映射，不直接执行 SQL。上游协议由显式 `provider_type` 与能力矩阵决定，禁止根据 URL、Key 或模型名猜测。

## 请求生命周期

1. Fastify 钩子验证代理 Token、限制请求体并创建请求上下文。
2. `RuntimeConfigManager` 按客户端模型筛选启用且健康的路由。
3. `RoutingPolicy` 选择最小 `priority` 组，再按 `weight` 加权。
4. `ApiKeyRotator` 从 SQLite 事务获取 Key lease，并应用冷却、并发和配额规则。
5. `UpstreamService` 构造认证头、执行请求并按错误类别决定是否更换 Key 重试。
6. 响应被透传、协议转换或 SSE 修复；usage、错误状态和 lease 最终写回 SQLite。

响应体尚未输出时允许在同一 Provider 内切换 Key。流式输出开始后不得重放请求，以避免重复计费；中途失败只关闭协议流、释放 lease 并影响后续选择。

## 协议与流式处理

代理提供 Anthropic Messages、Token 统计、OpenAI Chat Completions、OpenAI Responses 和模型列表。请求头采用黑名单剥离：删除 hop-by-hop、`host` 与 `content-length`，保留客户端实验头和供应商私有头，再按 Provider 类型注入认证。响应同样删除 hop-by-hop、压缩和长度头，避免 Fetch 解压后客户端再次解压。

Anthropic Provider 直接使用 Messages 协议；OpenAI-compatible Provider 可接收 Chat Completions，并在 Messages 入口执行双向转换。Responses 能力默认关闭，只有 Provider 明确启用后才参与该端点路由。

系统区分原生 Anthropic SSE、OpenAI SSE、半成品 Anthropic SSE 和未知字节流。OpenAI SSE 会转换为完整 Anthropic 事件序列；Anthropic SSE 修复器补齐消息 ID、usage、content block、stop reason 和结束事件，并支持任意网络分块。流读取同时监听 idle 超时和客户端断开；客户端断开时立即停止读取与写入、释放 lease，且不把断开误记为 Key 故障。

## 路由与故障隔离

同一客户端模型可以配置多条路由。系统先排除停用 Provider、停用路由、无可用 Key、配额阻断和熔断候选，再从最小 `priority` 组按 `weight` 加权选择。权重总和为零时均匀回退。

Provider 默认在连续网络错误或 5xx 后打开熔断，冷却结束只允许一个半开探测。429、鉴权、配额和请求错误只影响当前 Key 或请求，不计入 Provider 连接故障。熔断改变后续请求的候选集合，不跨 Provider 重放可能已被上游受理的请求。

## Key 调度与配额

每个 Key 使用稳定 ID，明文不参与运行态主键。`sticky` 策略尽量保持当前 Key，`balanced` 策略在可用 Key 间分散请求。选择过程同时考虑手动停用、错误自动禁用、429 冷却、最大并发、请求间隔、本地配额和共享 lease。

成功请求清理错误计数；可恢复错误在重试次数和总耗时预算内切换 Key。每个 Key 可设置请求数、Token 和美元预算，达到软停阈值后暂时离开候选池，但不会改变用户配置的启用状态。管理员重置用量后立即恢复。

## Web 管理端

管理端是面向桌面浏览器的五视图工作区：概览、供应商、模型路由、策略和活动日志。供应商视图维护类型、地址、能力、Key、配额、熔断与连接测试；模型视图维护客户端别名、上游模型、优先级、权重和启停状态；策略视图维护代理 Token、默认模型、防封和自动禁用参数。

配置历史保留最近 50 个 revision。回滚会基于历史内容创建新 revision，不会让版本号倒退。所有写操作使用 `If-Match`，避免多个页面静默覆盖配置。普通页面只持有脱敏视图，不展示原始配置或秘密；完整 Key 只在管理员主动导出时返回，导出事件本身不记录 Key 内容。

## SQLite 一致性与迁移

`ccop.db` 是唯一运行时数据库。仓储启用 WAL、外键、`busy_timeout` 和显式 schema migration，统一保存当前配置、最近 50 个历史版本、Key 状态与用量、并发 lease、Provider 熔断和半开探测 lease。

配置写入使用 revision CAS，对应管理 API 的 `ETag` 与 `If-Match`。Key 获取、释放、冷却、计数和用量增量使用 `BEGIN IMMEDIATE` 事务；lease 带唯一 ID 和 TTL，Worker 崩溃后可由后续事务回收。每个 Worker 使用独立连接，并在请求入口检测 revision 前进后重建内存视图。

旧配置文件不是运行时存储，只作为旧安装升级输入。启动前迁移只检查固定候选路径，并且仅在 `ccop.db` 未初始化时执行。显式 `ccop migrate` 支持预检；迁移在单个事务中导入配置、状态、用量和历史，保留停用的 Provider、模型及 Key，不修改源文件。已初始化或包含非 CCOP 数据的目标库会被拒绝。

## 可观测性与安全

`/livez` 仅表示进程存活，`/readyz` 在运行配置完成初始化后返回就绪，`/metrics` 输出请求量、状态、延迟、TTFB、活跃请求、上游错误、重试和上游 usage。未返回 usage 的响应不会被估算。

日志支持 text 与 JSON 两种输出格式及轮转，但两者都不记录请求/响应正文或凭证。为定位路由问题，文件日志和活动事件会记录客户端模型别名与上游原始模型名；Prometheus 指标仍不使用模型名作为标签。管理会话使用 HttpOnly Cookie；代理接口使用独立 Token。活动 SSE 只保留最近 100 条脱敏事件。指标、事件、日志和 Webhook 均禁止包含 Key、Token、敏感 Header 和高基数请求字段。Provider 连接测试只请求能力允许的 `/models`，不调用生成接口。

## 运行边界与验证

本项目只提供 Web 服务和桌面浏览器管理端，不开发原生桌面应用、移动端布局或窄屏交互。核心存储固定为 SQLite 单库；协议和 Provider 扩展应继续通过显式能力矩阵与适配器完成。

协议、流式分块、重试分类、事务竞争、迁移失败、配置冲突和敏感信息边界都应有独立测试。提交前至少运行 `pnpm check` 与 `pnpm test`；修改覆盖率清单中的核心服务时运行 `pnpm test:coverage`。
