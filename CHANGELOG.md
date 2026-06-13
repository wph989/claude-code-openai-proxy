# Changelog

## [0.4.3] - 2026-06-12

### Fixed

- **🔧 修复 Claude Code 客户端兼容性问题**
  - **响应头完整转发**：保留上游的 `anthropic-version`, `anthropic-beta`, `x-request-id`, `x-ratelimit-*` 等关键响应头
  - **自动移除 content-encoding**：Node.js fetch 自动解压缩响应体，代理现在会正确移除 `content-encoding` 头，避免客户端重复解压
  - **请求头完整透传**：只移除 hop-by-hop 头（RFC 7230 §6.1），保留客户端的所有其他头（包括 `content-type`, `user-agent` 等）
  - **不再强制覆盖 content-type**：保留客户端指定的 `content-type`（如 `application/json; charset=utf-8`）

### Technical

- 新增 `src/services/response-headers.ts`：
  - `extractUpstreamHeaders()` - 从上游响应提取关键头（用于流式响应）
  - `setUpstreamHeaders()` - 设置上游响应头（用于非流式响应）
- 修改 `src/services/upstream.ts`：
  - 移除 `HEADERS_TO_OVERRIDE` 常量
  - `buildHeadersWithKey()` 只过滤 hop-by-hop 头，保留所有其他客户端头
  - `x-request-id` 和 `x-claude-code-session-id` 改为补充而非覆盖
- 修改 `src/routes/messages.ts`：
  - 所有流式响应使用 `extractUpstreamHeaders()` 而非硬编码响应头
  - 所有非流式响应使用 `setUpstreamHeaders()` 转发上游头
- **与 Python 参考脚本 `http_forward.py` 行为完全对齐**

## [0.4.2] - 2026-06-12

### Added

- **模型重名支持**：允许多个路由使用相同的 `client_model` 名称，请求时会随机选择一个启用的路由
  - 场景：负载均衡、多供应商容错
  - 示例配置：
    ```json
    {
      "models": [
        { "client_model": "gpt-4", "provider_id": "openai", "upstream_model": "gpt-4-turbo" },
        { "client_model": "gpt-4", "provider_id": "azure", "upstream_model": "gpt-4" },
        { "client_model": "gpt-4", "provider_id": "deepseek", "upstream_model": "gpt-4" }
      ]
    }
    ```
  - 每次请求 `gpt-4` 时，会从三个供应商中随机选择一个（只选择 `enabled: true` 的路由）

### Changed

- **UI 状态提示优化**：保存/加载状态提示现在固定在屏幕顶部（不随页面滚动），方便用户始终看到操作反馈

### Technical

- 移除了 `validateRuntimeConfig` 中对 `client_model` 重复的校验
- 修改了 `RuntimeConfigManager.resolveModel()` 逻辑：
  - 从 `find()` 改为 `filter()` 找到所有匹配的启用路由
  - 多个路由时使用 `Math.random()` 随机选择
- 更新了 `admin.css` 中 `.status-bar` 样式，使用 `position: fixed` 固定定位

---

## [0.4.1]

### Added

- 防封重试和运行态持久化优化
- API Key 轮询与防封重试增强

## [0.4.0]

### Added

- 完整的响应修复功能（参考 `http_forward.py`）
- 流式 SSE 修复（`StreamingAnthropicSSEFixer`）
- 请求头透传优化（保留客户端身份信息）
- Anthropic 协议严格校验（5 字段 usage、stop_reason 映射）
