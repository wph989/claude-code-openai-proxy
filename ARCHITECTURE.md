# 架构与功能模块

## 1. 系统定位

本项目是 Node.js 22.5+、TypeScript ESM 和 Fastify 实现的多供应商 LLM 代理。它向客户端提供 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses API，并按显式 `provider_type` 连接 Anthropic 或 OpenAI-compatible 上游。管理端是面向桌面浏览器的原生 ESM Web UI。

## 2. 模块边界

```text
src/
  cli.ts                    # start/stop/status/ui/init-config/migrate
  server.ts                 # Fastify 组装、钩子与生命周期
  cluster.ts                # Worker 创建、回收与关闭
  routes/                   # HTTP 参数解析与响应映射
    admin/                  # session/config/providers/keys/events
    messages.ts             # Anthropic Messages 与 count_tokens
    chat-completions.ts     # OpenAI Chat Completions
    responses.ts            # OpenAI Responses
    health.ts               # /livez、/readyz、/metrics
  services/
    runtime-config.ts       # 配置、路由和 Rotator 协调
    admin-config-service.ts # 资源级配置写入
    key-admin-service.ts    # 稳定 ID Key 管理
    api-key-rotator.ts      # Key 选择、冷却、并发与恢复
    routing-policy.ts       # priority + weight 路由策略
    provider-health.ts      # 熔断与半开探测
    upstream.ts             # 上游请求、错误分类与重试
    providers/              # ProviderAdapter 能力矩阵
    response-fix/           # SSE codec、修复状态机和转换
    config/
      repository.ts                 # 存储端口
      sqlite-config-repository.ts   # SQLite 配置、状态、用量与历史
      sqlite-key-runtime-coordinator.ts
      sqlite-provider-circuit-coordinator.ts
      json-to-sqlite-migration.ts   # 一次性旧 JSON 导入
  static/                   # 桌面浏览器管理端
  types/runtime-config.ts   # 纯类型契约
tests/                      # Vitest 回归测试
```

依赖方向保持为：

```text
Fastify Routes
  -> Application Services
  -> Domain Policies / Coordinators
  -> Repository / Provider Ports
  -> SQLite / HTTP Adapters
```

路由层不直接执行 SQL 或 Key 状态转换。Provider 协议只能由 `provider_type` 和能力矩阵决定，禁止根据 URL、Key 或模型名推断。

## 3. SQLite 与多 Worker

`ccop.db` 是唯一生产运行时存储。SQLite 启用 WAL、`busy_timeout`、外键与显式 schema migration，并统一保存：

- 当前配置和最近 50 个历史快照；
- Key 状态、用量与带 TTL 的并发 lease；
- Provider 熔断状态和半开探测 lease。

配置写入使用 revision CAS，避免页面或 Worker 静默覆盖。Key acquire/release、冷却、错误计数和用量增量通过 `BEGIN IMMEDIATE` 事务协调；Worker 崩溃后过期 lease 会被回收。`${providerId}:${keyId}` 是稳定运行态主键，Key 字面量不会进入该主键。

旧 `runtime_models.json`（早期安装名为 `config.json`）、`runtime_state.json`、`runtime_usage.json` 和 `runtime_history.json` 可由 `ccop migrate` 显式读取；启动时也会按固定候选路径检查主配置，仅在 `ccop.db` 未初始化且源文件存在时自动迁移。迁移要求目标库未初始化，在单个事务中导入，并保持源文件不变。

## 4. 请求与状态流

```text
Client
  -> proxyAuthHook
  -> RuntimeConfigManager.resolveModel
  -> RoutingPolicy 过滤能力/健康/配额并选择 route
  -> ApiKeyRotator.acquire (SQLite lease)
  -> UpstreamService.fetch
  -> 协议透传、转换或 SSE 修复
  -> recordUsage + release/markError
  -> Client
```

同名模型先选择最小 `priority`，再按 `weight` 分配。网络和 5xx 可触发 Provider 熔断；429、鉴权、配额和请求错误只影响 Key 或当前请求。响应尚未输出时可以切换 Key 重试；开始输出后不得重放请求，避免重复计费。

## 5. 管理面安全

- `GET /api/config` 和普通 Key 查询只返回脱敏 DTO，不下发完整 Key、代理 Token 或敏感 Header。
- 原始 JSON 展示已删除；变更预览由服务端返回字段级摘要。
- Provider、路由、设置、Token 和 Key 使用资源级接口及稳定 ID；整体 `PUT /api/config`、数字 Key 索引和 `/healthz` 已删除。
- 所有配置写入要求 `If-Match`；冲突返回 `409`，缺少前置条件返回 `428`。
- 完整 Key 只在管理员主动导出时返回；审计事件不得包含 Key 内容。
- 指标、日志、Webhook 和管理 SSE 禁止包含 Key、Token、请求正文、内部模型名及高基数字段。

## 6. 生命周期与验证

`server.ts` 在 Fastify `onClose` 中关闭 `RuntimeConfigManager` 和 SQLite 连接。请求入口按 revision 检查其他 Worker 的配置更新；只有 revision 前进才重建内存视图。管理端只面向桌面浏览器，不开发 Electron/Tauri 或移动端布局。

行为变更必须运行 `pnpm check`、`pnpm test` 和 `pnpm test:coverage`。协议流、事务竞争、迁移失败、配置冲突和敏感信息边界需要独立回归测试。
