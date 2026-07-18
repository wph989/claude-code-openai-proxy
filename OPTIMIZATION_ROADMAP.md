# 代码、架构与管理端优化路线图

## 1. 目标与原则

本路线图用于提升代理服务的正确性、安全性、可维护性与运维效率，并为后续协议和集群能力留出稳定扩展边界。

- 优先修复可复现的正确性与管理面风险，再进行结构拆分和视觉改造。
- 保留现有 HTTP 行为、配置字段层级和协议语义，采用兼容门面渐进迁移，避免一次性重写。
- Provider 协议必须继续由显式 `provider_type` 区分，不根据 URL、Key 或模型名推断。
- 只在 I/O、协议和存储边界引入接口，不建设通用 DI 容器或事件总线。
- 关键状态机、并发边界和兼容策略必须用中文注释解释设计原因。

### 已确认决策：密钥导出

`GET /api/keys/:providerId/export` 保持现有管理员登录态权限即可使用，不增加二次验证，也不默认关闭。普通配置和 Key 查询接口仍应返回脱敏视图；只有用户主动执行导出时返回完整 Key。引入审计日志后，应记录导出事件但不得记录 Key 内容。

## 2. 当前基线

- TypeScript 已启用严格模式，Vitest 当前 31 个测试文件、233 项测试通过。
- 当前统计范围内行覆盖率为 88.80%、分支为 85.17%、函数为 91.00%；`runtime-config.ts` 为 79.47%、`upstream.ts` 为 82.52%。
- `vitest.config.ts` 尚未纳入多数路由、`server.ts`、`response-fix.ts` 和管理端主流程，因此总百分比不能代表完整风险覆盖。
- 当前剩余复杂度主要集中在 `src/services/runtime-config.ts`、`src/services/api-key-rotator.ts` 与智能路由/多 Worker 状态协调；管理路由、响应修复和前端主流程已完成首轮拆分。

### 实施进度（2026-07-18）

- [x] 路由选择先排除停用 Provider、无 Key 与配额阻断候选，并注入可测试随机源。
- [x] Key API 改用稳定 ID，旧数字索引响应带 `Deprecation: true`；模型映射自动补 `route_id`。
- [x] 普通管理查询改用服务端脱敏 DTO；Token 独立轮换，完整 Key 仅主动导出。
- [x] 配置加入 revision、`ETag` / `If-Match`、409 冲突和 428 前置条件检查。
- [x] 删除原始 JSON 展示，替换为服务端字段级变更预览。
- [x] 新增全局设置、Provider 和模型路由资源级接口，旧整体配置接口保留为兼容门面。
- [x] 管理路由按 session/config/keys 拆分；自动恢复调度与显式 `ProviderAdapter` 注册表完成拆出。
- [x] 管理前端集中 API、ETag、401/409 与状态处理，并移除外部字体和装饰性视觉元素。
- [x] 抽出 Key 管理服务，并拆分 `response-fix.ts`、logger 与前端 views/forms/components。
- [x] 合并弹窗、补齐焦点循环与 ARIA；桌面 Chromium 验收通过，Playwright 本身不调用模型或外部 API。
- [x] 新增 `/metrics`、`/livez`、`/readyz`，覆盖 HTTP 延迟/TTFB、活跃请求、上游错误/重试和非流式/流式 Token 用量。
- [x] 实现脱敏管理事件 SSE、桌面活动日志和 Provider `GET /models` 主动连接测试。
- [ ] 实现优先级/权重/熔断/半开路由策略。
- [ ] 实现 SQLite WAL、多 Worker 事务 lease 与阶段六产品扩展。

## 3. 阶段一：正确性与管理面安全

### 3.1 修复模型路由候选选择

修改 `RuntimeConfigManager.resolveModel()`：先筛选启用的模型映射、启用的 Provider 和具备可用 Key 的候选，再执行选择策略。短期可保留随机策略，但应注入随机源以便稳定测试；后续由 `RoutingPolicy` 接管。

验收标准：

- 停用的 Provider 永远不会被选中。
- 同名路由中一个 Provider 不可用时，仍能选择其他健康候选。
- 候选全部不可用时返回明确、稳定的错误信息。
- 新增停用 Provider、无可用 Key 和单候选三类回归测试。

### 3.2 使用稳定资源 ID

将 Key 管理接口从 `:keyIndex` 迁移为已有的 `:keyId`；为模型映射增加稳定 `route_id`。旧索引接口保留一个兼容周期并标记弃用，内部实现统一按 ID 查找。

验收标准：Key 或路由重排后，编辑、删除、启停和配额操作仍作用于原资源；不存在因页面数据过期而修改错误对象的情况。

### 3.3 建立脱敏管理 DTO

新增独立的 `AdminConfigView` 和 `AdminKeyView`，普通接口只返回 Key `id`、掩码、备注、配额及运行状态；代理鉴权 Token 只返回“是否已配置”。新增 Key 和轮换代理 Token 使用独立写接口，避免浏览器保存完整配置时回传全部凭证。

- 删除管理端“原始 JSON 预览”，改为服务端校验并生成的脱敏配置变更摘要。
- `GET /api/config` 不得返回完整 Key 或代理 Token；Token 仅返回 `proxy_auth_token_configured`。
- `authorization`、`x-api-key` 及名称含 `token`、`secret`、`password` 的 Header 值由服务端 DTO 统一置空，保存时按名称保留既有值。
- 普通 Key 查询只返回稳定 ID、掩码和状态；完整 Key 仍只由用户主动调用导出接口取得。
- 禁止依赖前端字符串替换、CSS 隐藏或折叠面板完成安全脱敏，因为明文仍会留在网络记录和 JavaScript 内存中。

### 3.4 防止并发覆盖配置

为配置增加单调递增 `revision`，读取时返回 `ETag`，写入时使用 `If-Match`。版本不一致返回 `409 Conflict` 和最新 revision。逐步把整体 `PUT /api/config` 拆为全局设置、Provider、模型路由和策略的资源级 `PATCH/POST/DELETE`；旧 PUT 在兼容期内保留。

验收标准：两个管理页面同时编辑时，后提交的旧版本不会静默覆盖新版本；UI 能展示冲突并让用户重新加载或查看差异。

### 3.5 补齐高风险测试

- 使用 Fastify `inject()` 覆盖登录、鉴权、脱敏 DTO、稳定 ID、revision 冲突和配置回滚。
- 将路由、协议修复、流式桥接和管理服务逐步纳入覆盖率统计，按模块设置门槛。
- 对 SSE 修复增加不同分块边界的参数化测试，保证同一事件任意切块后结果一致。
- 为时间、随机数、`fetch` 和 logger 提供轻量依赖注入，减少真实等待和全局替换。

## 4. 阶段二：行为保持型架构重构

目标依赖方向：

```text
Fastify Routes
  -> Application Services
     ConfigService / KeyAdminService / RequestRouter
  -> Domain Policies
     RoutingPolicy / KeyPool / RetryPolicy / QuotaPolicy
  -> Ports
     ConfigRepository / RuntimeStateRepository / MetricsSink / ProviderAdapter
  -> Adapters
     JSON / SQLite / Anthropic / OpenAI / Prometheus
```

具体拆分：

- 保留 `RuntimeConfigManager` 作为兼容门面，抽出配置加载保存、模型路由、Rotator 注册、运行态协调和 Key 管理。
- 将 `api-key-rotator.ts` 中的 lease 调度、健康状态转换、自动恢复和用量处理分成可独立测试的协作对象。
- 将 `response-fix.ts` 拆为 SSE 解析、Anthropic 修复状态机和 OpenAI 转换模块，并保留现有导出入口。
- 将 `routes/admin.ts` 按 session、config、providers、routes 和 keys 分组，路由层只负责参数解析与响应映射。
- 把全局 logger 改为实例化依赖，使测试和多 Worker 环境互不污染。
- 引入按显式 `provider_type` 注册的 `ProviderAdapter`，统一 URL、认证头、计数能力和协议转换入口。

重构顺序必须遵循“先补特征测试，再移动职责，最后删除兼容层”。每次只迁移一个边界，并运行 `pnpm check`、`pnpm test` 和 `pnpm test:coverage`。

## 5. 阶段三：管理端 UI

### 5.1 信息架构

管理端调整为五个工作视图：概览、供应商、模型路由、策略、活动日志。概览展示运行健康、请求量、延迟、重试和 Key 可用性；供应商列表进入详情抽屉管理 Key；全局策略不再与资源列表混在同一条长页面中。

### 5.2 前端代码组织

先继续使用原生 ESM，将 `src/static/admin.js` 拆分为 `api-client.js`、`store.js`、`views/`、`forms/` 和 `components/`。统一现有两套弹窗实现，并集中处理 API 错误、会话失效、脏状态和渲染转义。只有当视图和图表规模继续明显增长时，再评估 Vite + Preact，不立即引入大型前端框架。

### 5.3 交互与视觉

- 增加未保存状态栏、保存前差异预览、字段级错误和配置冲突处理。
- 管理端是面向桌面浏览器的 Web UI，使用紧凑表格与详情抽屉；不开发原生桌面应用，也不规划移动端布局、触控交互或窄屏适配。
- 合并弹窗后补齐焦点锁定、焦点恢复、`aria-live`、键盘操作和 `prefers-reduced-motion`。
- 移除外部 Google Fonts、Playfair 展示字体和过大的统计数字，改用本地系统字体与清晰的语义状态色。
- 操作按钮使用统一图标和 tooltip；建立构建流程后优先采用 Lucide 图标。

### 5.4 UI 验证

为纯状态和渲染模块增加 Vitest DOM 测试；使用 Playwright 覆盖登录、创建 Provider、编辑路由、管理 Key、保存冲突和退出流程，并验证桌面截图、键盘导航和文本不溢出。

## 6. 阶段四：可观测性与智能路由

- 增加 Prometheus `/metrics`，记录请求量、成功率、延迟、TTFB、活跃请求、重试次数、错误类别和 Token 用量。
- 增加管理端事件 SSE，实时推送 Provider、Key、配额和请求摘要变化，避免频繁轮询。（已完成首版）
- 将 `/healthz` 拆为存活检查与就绪检查，并增加主动 Provider 连接测试。（已完成）
- 新增优先级、权重、熔断和半开探测策略；同名模型路由可在健康 Provider 间故障转移。
- 指标 label、事件和日志禁止包含完整 Key、Token、请求正文或其他高基数字段。

跨 Provider 重试只能发生在尚未向客户端输出响应且错误类别允许重试时。需要评估上游已受理但响应丢失导致的重复计费，并在支持时透传幂等键。

## 7. 阶段五：SQLite 与多 Worker

新增 SQLite WAL 实现与显式 schema migration。多 Worker 的前提不是简单把 JSON 换成 SQLite，而是让 Key acquire/release、并发计数、冷却、错误状态和配额更新具备事务语义，并为异常 Worker 的 lease 提供 TTL 回收。

验收标准：

- 两个 Worker 并发获取 Key 时不会超过 `max_concurrent`。
- Worker 崩溃后过期 lease 可恢复，Key 不会永久占满。
- 配置、状态和用量迁移可回滚，旧 JSON 可导入且不会丢失稳定 ID。
- 完成压力与故障注入测试后，才解除当前多 Worker 限制。

## 8. 阶段六：功能扩展

按产品价值依次推进：Provider 配置预演与连接测试、配置历史及回滚、Token/费用预算、Webhook 告警、显式 capability 矩阵、OpenAI Responses API。多租户、RBAC 和通用插件系统保持为按需能力，在出现明确用户场景前不提前建设。

## 9. 完成定义

每个阶段完成时必须满足：

- 新增或修改行为具有回归测试，关键边界具有中文原因注释。
- `pnpm check`、`pnpm test` 和相关覆盖率门槛通过。
- 配置格式、HTTP 兼容性与迁移策略已记录，破坏性变更具有弃用周期。
- 管理端变更通过桌面布局、键盘操作、文本溢出和敏感信息检查。
- 文档同步更新 `README.md`、`ARCHITECTURE.md` 或 `FEATURES.md` 中受影响的契约。
