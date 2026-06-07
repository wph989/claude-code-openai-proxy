# Claude Code OpenAI Proxy

Claude Code 多供应商代理（TypeScript / npm 版）：

- 对外暴露 Anthropic Messages 风格接口，供 Claude Code 使用
- 对内转发到 OpenAI-compatible 上游，例如 Ollama、vLLM、NIM、各类兼容网关
- 支持多供应商、多模型映射、Web UI 配置管理、配置热生效、JSON 日志
- 全局安装后通过 `ccop` 命令快速启动

## 主要特性

- **协议转换**：Anthropic ↔ OpenAI 自动转换
- **多供应商**：支持多个上游供应商，自动故障切换
- **配置管理**：Web UI 表单化配置，热生效无需重启
- **守护进程**：支持后台运行、自动记录 PID
- **便捷 CLI**：`ccop start/stop/status/ui` 命令
- **日志**：结构化 JSON 日志，支持日志级别控制

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
    health.ts           # 健康检查
    messages.ts         # Anthropic Messages API
    chat-completions.ts # OpenAI Chat Completions 透传
  services/
    runtime-config.ts   # 运行时配置
    transformers.ts     # 协议转换
    upstream.ts         # 上游请求 + 重试预算
    stream-bridge.ts    # 流式响应桥
    api-key-rotator.ts  # 多 Key 调度器（acquire/release/markError）
    anti-ban-config.ts  # anti-ban 字段归一化与 mode 预设
    health-tracker.ts   # Key 健康分（滑动窗口）
    key-selectors.ts    # Sticky / Balanced 选择器
    quota-guard.ts      # 本地配额软停
    usage-store.ts      # 配额计数持久化（runtime_usage.json）
    key-state-store.ts  # Key 运行态持久化（runtime_state.json，error_count / disabled_at 等）
  static/
    login.html        # 登录页
    index.html        # 管理页
  utils/
    pid.ts            # 进程管理
    logger.ts         # 日志工具
    atomic-write.ts   # 原子 JSON 写入（tmp + rename）
    nanoid.ts         # 短稳定 id 生成（api_key.id）
    id.ts             # 请求 id 生成
    time.ts           # 时间工具
```

## 安装

### 方式一：全局安装（推荐）

```bash
npm install -g claude-code-openai-proxy
```

### 方式二：npx 直接运行（无需安装）

```bash
npx claude-code-openai-proxy start
```

## 快速开始

### 1. 初始化配置

```bash
ccop init-config
```

这会创建运行时配置文件。根据启动方式不同，文件位置不同：
- **开发模式**（`--dev` 或 `NODE_ENV=development`）：当前目录 `runtime_models.json`
- **生产模式**（npm 全局安装）：`~/.ccop/config.json`

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
| `ccop init-config` | 初始化配置文件 |
| `ccop --version` | 查看版本 |

### 开发模式 vs 生产模式

| 模式 | 启动方式 | 配置位置 | 日志位置 | PID 位置 |
|------|---------|---------|---------|---------|
| **开发** | `ccop start --dev`<br>or `NODE_ENV=development ccop start`<br>or `pnpm run dev` | 项目目录 `.env`<br>项目目录 `runtime_models.json` | 项目目录 `logs/app.log` | 项目目录 `pids/` |
| **生产** | `ccop start` (npm -g 安装后) | `~/.ccop/.env`<br>`~/.ccop/config.json` | `~/.ccop/logs/app.log` | `~/.ccop/pids/` |

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

# 认证令牌
ADMIN_AUTH_TOKEN=admin123

# 配置文件（可选，覆盖默认位置）
# CONFIG_FILE=./runtime_models.json  # 开发模式
# CONFIG_FILE=/home/user/.ccop/config.json  # 生产模式

# 日志配置
LOG_LEVEL=info          # debug, info, warn, error
LOG_FORMAT=json         # json, text
LOG_DETAILED=false      # 是否记录详细请求/响应
```

## runtime_models.json 配置

```json
{
  "providers": [
    {
      "provider_id": "openai-compatible",
      "provider_type": "openai_compatible",
      "base_url": "https://api.example.com/v1",
      "api_key_env": "PROVIDER_API_KEY",
      "api_key": [
        {
          "key": "sk-example-key-1",
          "enabled": true,
          "quota": { "max_requests": 1000, "max_tokens": null, "soft_stop_threshold": 0.95 }
        },
        { "key": "sk-example-key-2", "enabled": true }
      ],
      "key_rotation_strategy": "round_robin",
      "auto_disable_on_error": true,
      "timeout_seconds": 300,
      "enabled": true,
      "headers": {},
      "description": "示例供应商"
    }
  ],
  "models": [
    {
      "client_model": "claude-model",
      "provider_id": "openai-compatible",
      "upstream_model": "your-upstream-model",
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

`api_key` 支持单字符串或对象数组：数组项可单独配 `enabled`、`quota`、`note` 等字段。多数场景只需要配置 `anti_ban.mode`，其他字段都有保守默认值。

## 配置文件分层

代理把"用户配置"与"程序运行时自动写入"分到不同文件，避免长跑期间反复改写用户配置：

| 文件 | 写入来源 | 内容 |
|---|---|---|
| `runtime_models.json` | **用户**（admin UI / 手编） | providers / models / anti_ban / 全局设置 / `api_key` 的用户字段（id、key、enabled、note、quota） |
| `runtime_state.json` | **程序自动**（v2，按 `providerId:id` 索引） | Key 运行态：`error_count` / `disabled_at` / `last_error_at` / `last_error_message` / `auto_disabled_at` |
| `runtime_usage.json` | **程序自动**（v2，按 `providerId:id` 索引） | per-Key 配额计数（requests_used / tokens_used） |

每个 `api_key` 项有一个稳定的 10 字符 nanoid `id`。state / usage 用 `providerId:id` 而非 key 字面量做主键，好处有二：(1) 改 token 续期不丢历史；(2) 持久化文件不再出现 key 字面量。手编 `runtime_models.json` 时漏写 `id` 字段也无妨——首次加载时自动补完并回写一次干净版本。

旧版 `runtime_state.json` / `runtime_usage.json`（v1，按 key 字面量索引）会被识别并丢弃，等价于"重置"。`runtime_state.json` / `runtime_usage.json` 默认随 `runtime_models.json` 同目录创建，已加入 `.gitignore`。

admin 页面的所有 anti_ban 字段——含 `health.*`、`selector.min_weight`、`retry.*`、`quota.persist_*`——都支持**保存即热更新**，无需重启。

## 防封策略（anti-ban）

代理内置三层防御，专为 Claude Code 长任务被 429 / 配额错误中断而设计：

1. **健康评分 + 智能选择器**（`HealthTracker` + `Sticky` / `Balanced`）：以滑动窗口跟踪每个 Key 的近期错误，把流量倾斜到健康度高的 Key。
2. **代理内有预算重试**（`UpstreamService`）：遇到 429 / 5xx 等可恢复错误，在 `max_attempts` 与 `max_total_ms` 双重限制下自动换 Key 重试，对路由层透明。
3. **本地配额守护**（`QuotaGuard` + `UsageStore`）：每个 Key 可配 `max_requests` / `max_tokens` / `soft_stop_threshold`，接近上限自动软停用（不翻 `enabled`，admin 重置后立刻恢复）；usage 计数事件驱动落盘到 `runtime_usage.json`，进程重启不丢失。

`anti_ban.mode` 提供两套预设：`conservative`（默认，保守串行）与 `throughput`（更高并发与更短间隔）。建议优先只改这个字段；确实需要细调时，provider 级 `anti_ban` 会覆盖全局值。常用覆盖项：

- `key_selection: sticky | balanced` —— sticky 模式粘住健康分最高的 Key；balanced 模式按健康分加权随机。
- `sticky_on_cooldown: fallthrough | wait` —— sticky 命中冷却时是否降级到下一个候选。
- `retry.max_attempts` / `retry.max_total_ms` —— 控制代理内自动重试的次数与总耗时预算。
- `stream_idle_timeout_seconds`（provider 级）—— 流式响应超过该空闲时长视为僵死，立刻断开换 Key。

`health`、`selector.min_weight`、`quota.persist_*` 属于高级调参项，默认值通常不需要改；完整字段见 `src/services/anti-ban-config.ts` 的 `ANTI_BAN_DEFAULTS`。admin 页面通过【高级调参】折叠面板暴露这些字段，保存即生效。

### Admin 端点

Key 与配额管理（均在 `/api/keys/:providerId/...` 下）：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET`    | `/api/keys/:providerId`                        | 列出所有 Key + 健康分 + 配额状态 |
| `GET`    | `/api/keys/:providerId/export`                 | 导出（脱敏可选） |
| `POST`   | `/api/keys/:providerId`                        | 新增 Key |
| `DELETE` | `/api/keys/:providerId/:keyIndex`              | 删除 Key |
| `PUT`    | `/api/keys/:providerId/:keyIndex/enable`       | 启用 |
| `PUT`    | `/api/keys/:providerId/:keyIndex/disable`      | 禁用 |
| `PUT`    | `/api/keys/:providerId/:keyIndex/reset`        | 清零错误计数 |
| `PUT`    | `/api/keys/:providerId/reset-all`              | 批量清零错误计数 |
| `PUT`    | `/api/keys/:providerId/:keyIndex/note`         | 修改备注 |
| `POST`   | `/api/keys/:providerId/:keyIndex/quota/reset`  | 清零本地 usage 计数 |
| `PUT`    | `/api/keys/:providerId/:keyIndex/quota`        | 更新或清除 `quota`（in-place 应用，保留 health 状态） |

Admin UI（`/admin`）：每个 Key 展示健康分徽章（绿 / 黄 / 红，按 0.7 / 0.4 阈值）、请求与 Token 配额进度条、软停用标记，以及「重置」「重置配额」「删除」按钮。

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
npm install

# 开发模式（热加载）
npm run dev

# 构建
npm run build

# 本地运行
npm start

# 测试
npm test              # 跑一次 vitest
npm run test:watch    # 监听模式
npm run test:coverage # 覆盖率报告（@vitest/coverage-v8）
```

## 发布到 npm

### 1. 登录 npm

```bash
npm login
```

### 2. 版本更新

```bash
# 更新版本号（遵循 semver）
npm version patch   # 修复版: 0.1.0 -> 0.1.1
npm version minor   # 小版本: 0.1.0 -> 0.2.0
npm version major   # 大版本: 0.1.0 -> 1.0.0
```

### 3. 构建并发布

```bash
npm run build
npm publish --access public --no-git-checks
```

#### 撤销发布
```bash
pnpm unpublish claude-code-openai-proxy@0.2.0 --force
```

### 4. 更新标签（可选）

```bash
# 发布 beta 版
npm version prerelease --preid=beta
npm publish --tag beta

# 发布 next 版
npm publish --tag next
```

### 发布后验证

```bash
# 等待 npm 同步（约 1-5 分钟）
npm view claude-code-openai-proxy versions

# 全局安装测试
npm install -g claude-code-openai-proxy
ccop --version
```

## License

MIT

## github地址

如果觉得有用，还请给个star
https://github.com/wph989/claude-code-openai-proxy