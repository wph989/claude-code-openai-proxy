# Claude Code OpenAI Proxy

面向 Claude Code 和其他 AI Agent 客户端的多供应商 Web 代理。CCOP 对外提供 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses 接口，对内连接 Anthropic 或 OpenAI-compatible 上游，并通过桌面浏览器管理端维护供应商、模型路由、Key、配额和运行策略。

项目地址：https://github.com/wph989/claude-code-openai-proxy

## 主要能力

- Anthropic Messages 与 OpenAI Chat Completions 双向转换，支持 Responses API。
- 多供应商、多模型别名、路由优先级与权重分流。
- 多 Key 调度、并发限制、429 冷却、分类重试、自动停用与独立用量统计。
- Provider 熔断、半开恢复、流式超时及 Anthropic/OpenAI SSE 修复。
- 单个 SQLite 数据库 `ccop.db` 保存配置、状态、用量、租约和配置历史。
- 桌面 Web 管理端提供配置热更新、历史回滚、活动日志和按日消耗曲线。
- 管理配置默认脱敏，完整 Key 仅在管理员主动导出时返回。
- 存活、就绪和 Prometheus 指标端点，以及可选的脱敏 Webhook 告警。

## 本次更新

- 运行时数据统一迁移到 `ccop.db`，支持多 Worker 事务协调。
- 旧 JSON 配置可在首次启动时自动迁移，停用资源和源文件均会保留。
- 管理端重构为概览、供应商、模型路由、策略和活动日志五个视图。
- 配额规则统一配置在供应商，Key 仍独立累计和重置用量。
- 完善流式协议处理、模型日志信息和 2xx 空响应错误累计。

## 环境要求

- Node.js 22.5 或更高版本。
- pnpm。
- 本项目只提供 Web 服务和桌面浏览器管理端，不包含原生桌面应用或移动端界面。

## 安装

全局安装：

```powershell
pnpm add --global claude-code-openai-proxy
```

也可以无需安装直接运行：

```powershell
pnpm dlx claude-code-openai-proxy start
```

## 快速开始

```powershell
# 启动服务
ccop start

# 打开管理端
ccop ui
```

默认地址：

- 管理端：`http://127.0.0.1:8765/admin`
- 代理入口：`http://127.0.0.1:8765`
- 存活检查：`http://127.0.0.1:8765/livez`
- 就绪检查：`http://127.0.0.1:8765/readyz`
- Prometheus 指标：`http://127.0.0.1:8765/metrics`

生产模式首次启动会创建 `~/.ccop/.env` 和 `~/.ccop/ccop.db`。随机管理口令写入 `~/.ccop/.env` 的 `ADMIN_AUTH_TOKEN`，不会直接输出到日志。

进入管理端后，依次完成以下配置：

1. 添加供应商及 API Key。
2. 添加客户端模型别名与上游模型映射。
3. 按需设置默认客户端模型和代理鉴权 Token。
4. 使用供应商列表中的连接测试检查 `/models` 能力。

## 接入 Claude Code

PowerShell：

```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:8765'
$env:ANTHROPIC_AUTH_TOKEN = '管理端配置的代理鉴权 Token'
claude
```

如果未配置代理鉴权 Token，代理接口不会要求 Token；生产环境建议始终配置。Claude Code 请求中的模型名应与管理端的客户端模型别名一致。

## CLI 命令

| 命令 | 说明 |
| --- | --- |
| `ccop start` | 前台启动生产模式服务 |
| `ccop start --dev` | 使用当前项目目录的 `.env` 和 `ccop.db` 启动 |
| `ccop start --port 8766` | 使用指定端口启动 |
| `ccop start --sqlite-file <path>` | 使用指定 SQLite 数据库 |
| `ccop start -d` | 后台守护模式启动 |
| `ccop start -c 4` | 使用 4 个 Worker 启动集群模式 |
| `ccop stop` | 停止由 CLI 启动的服务 |
| `ccop status` | 查看运行状态和端口 |
| `ccop ui` | 打开管理端 |
| `ccop init-config` | 在 SQLite 中初始化默认配置 |
| `ccop migrate --config <path>` | 将旧 JSON 数据迁移到 SQLite |
| `ccop --version` | 查看版本 |

## 开发与生产模式

| 模式 | 启动方式 | 配置和数据库 | 日志与 PID |
| --- | --- | --- | --- |
| 开发 | `pnpm dev` 或 `ccop start --dev` | 项目目录 `.env`、`ccop.db` | 项目目录 `logs/`、`pids/` |
| 生产 | `ccop start` | `~/.ccop/.env`、`~/.ccop/ccop.db` | `~/.ccop/logs/`、`~/.ccop/pids/` |

`pnpm dev` 通过 `tsx` 直接执行源码，但不会自动监听文件变化。完整的源码运行、独立开发数据库、测试和调试流程见 [本地开发指南](./docs/local-development.md)。

## 环境配置

常用环境变量：

```dotenv
HOST=0.0.0.0
PORT=8765
ADMIN_AUTH_TOKEN=change-me-random-admin-token
SQLITE_FILE=./ccop.db

LOG_LEVEL=info
LOG_FORMAT=text
LOG_DETAILED=false
LOG_FILE=./logs/app.log

KEY_AUTO_DISABLE=true
KEY_MAX_ERRORS=5
CLUSTER_WORKERS=1

ALERT_WEBHOOK_URL=
ALERT_BUDGET_THRESHOLD=0.85
ALERT_COOLDOWN_SECONDS=300
```

完整模板见 [`.env.example`](./.env.example)。供应商、模型、Key、配额和代理 Token 由管理端写入 SQLite，不再使用 JSON 作为日常配置来源。

## 公开接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/messages/count_tokens` | Anthropic Token 统计 |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses，需供应商显式启用能力 |
| `GET` | `/v1/models` | 当前可用客户端模型 |
| `GET` | `/livez` | 进程存活检查 |
| `GET` | `/readyz` | 配置就绪检查 |
| `GET` | `/metrics` | Prometheus 指标 |

代理 Token 可通过 `Authorization: Bearer <token>` 或 `x-api-key` 发送。管理端使用独立的 HttpOnly Cookie 会话。

## JSON 自动迁移

旧安装升级时，程序仅在目标 `ccop.db` 尚未初始化时检查约定的 `runtime_models.json` 或 `config.json`。迁移会一并读取同目录下存在的 `runtime_state.json`、`runtime_usage.json` 和 `runtime_history.json`，并保留已启用和已停用的供应商、模型及 Key。

显式预检和迁移：

```powershell
ccop migrate --config .\runtime_models.json --sqlite-file .\ccop.db --dry-run
ccop migrate --config .\runtime_models.json --sqlite-file .\ccop.db
```

迁移成功后源 JSON 不会删除或修改；数据库已经初始化时不会重复迁移。日常运行只使用 SQLite。

## 数据备份

停止服务后备份配置目录即可：

```powershell
ccop stop
Copy-Item "$HOME\.ccop\ccop.db" "$HOME\.ccop\ccop.db.backup"
Copy-Item "$HOME\.ccop\.env" "$HOME\.ccop\.env.backup"
```

不要提交 `.env`、`ccop.db`、真实 API Key、日志或导出的 Key 文件。

## 开发与发布文档

- [本地开发指南](./docs/local-development.md)
- [NPM 发布指南](./docs/npm-publishing.md)
- [系统架构与运行机制](./ARCHITECTURE.md)

## License

MIT
