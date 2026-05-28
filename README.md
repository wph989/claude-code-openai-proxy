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
    admin.ts          # 管理后台 API
    health.ts         # 健康检查
    messages.ts       # Messages API
  services/
    runtime-config.ts # 运行时配置
    transformers.ts   # 协议转换
    upstream.ts       # 上游请求
  static/
    login.html        # 登录页
    index.html        # 管理页
  utils/
    pid.ts            # 进程管理
    logger.ts         # 日志工具
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

# 日志配置
LOG_LEVEL=info          # debug, info, warn, error
LOG_FORMAT=json         # json, pretty
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
  "proxy_auth_token": null
}

```

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
