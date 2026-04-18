# Claude Code Gateway Proxy（TypeScript / npm 版）

这是 TypeScript 版本的 Claude Code 多供应商代理项目：

- 对外暴露 Anthropic Messages 风格接口，供 Claude Code 使用
- 对内转发到 OpenAI-compatible 上游，例如 Ollama、vLLM、各类兼容网关
- 支持多供应商、多模型映射、前端登录与配置管理、配置热生效、北京时间 JSON 日志
- 可以作为 npm 包发布，支持全局安装后通过快捷命令启动，也支持 `npx` 直接启动

## 主要能力

- 全链路异步
- 中文代码注释、中文管理界面、北京时间日志
- 通过 `runtime_models.json` 管理多个供应商和多个模型映射
- 保存配置后立即生效
- 前端表单化配置，不再直接手改 JSON
- 访问 `ip:port` 时先进入登录页，认证后才进入 `/admin`
- 非流式与流式请求都尽量从上游供应商响应的 `usage` 获取 token
- `/v1/messages/count_tokens` 会发起一次最小化上游请求，并从供应商响应里的 `usage.prompt_tokens` 读取输入 token
- CLI 命令可用于 npm 全局安装后的快捷启动

## 目录结构

```text
src/
  cli.ts                    # npm CLI 入口，支持 start / init-config
  server.ts                 # Fastify 服务入口
  config.ts                 # 环境变量配置
  auth.ts                   # 代理鉴权 / 管理后台鉴权
  models.ts                 # 数据模型与校验
  routes/
    admin.ts                # 登录页、管理页、配置接口
    health.ts               # /healthz
    messages.ts             # /v1/messages /v1/messages/count_tokens /v1/models
  services/
    runtime-config.ts       # 运行时配置管理与热更新
    transformers.ts         # Anthropic ↔ OpenAI 协议转换
    upstream.ts             # 上游请求封装
    stream-bridge.ts        # OpenAI SSE → Anthropic SSE 桥接
  static/
    login.html              # 登录页
    index.html              # 管理页
  utils/
    id.ts                   # request_id / session_id 生成
    logger.ts               # 北京时间 JSON 日志
    time.ts                 # 时间工具
scripts/
  postbuild.mjs             # 构建后复制静态文件
```

## 本地开发

```bash
npm install
cp .env.example .env
cp runtime_models.example.json runtime_models.json
npm run dev
```

启动后访问：

- 登录页：`http://127.0.0.1:8080/login`
- 管理页：`http://127.0.0.1:8080/admin`
- 根路径：`http://127.0.0.1:8080/`

## 本地构建与运行

```bash
npm run build
npm start
```

## 初始化配置文件

```bash
npm run build
node dist/cli.js init-config
```

也可以指定路径：

```bash
node dist/cli.js init-config --config ./runtime_models.json
```

## npm 发布后的使用方式

### 方式一：全局安装后使用快捷命令

```bash
npm i -g claude-code-gateway-proxy
ccnp start --host 0.0.0.0 --port 8080
```

也支持完整命令名：

```bash
claude-code-gateway-proxy start --host 0.0.0.0 --port 8080
```

### 方式二：不全局安装，直接使用 npx

```bash
npx claude-code-gateway-proxy start --host 0.0.0.0 --port 8080
```

## 发布到 npm

1. 先确认 `package.json` 里的 `name` 没有与现有包冲突
2. 执行构建
3. 登录 npm
4. 发布

```bash
npm run build
npm login
npm publish --access public
```

如果你更倾向于作用域包，可以把 `name` 改成例如：

```json
"name": "@your-scope/claude-code-gateway-proxy"
```

然后发布：

```bash
npm publish --access public
```

## Claude Code 接入

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN=你的 PROXY_AUTH_TOKEN
```

## 环境变量

`.env.example` 中最关键的是这几个：

```bash
ADMIN_AUTH_TOKEN=你的后台管理口令
CONFIG_FILE=./runtime_models.json
```

## runtime_models.json 示例

```json
{
  "providers": [
    {
      "provider_id": "provider1",
      "provider_type": "openai_compatible",
      "base_url": "https://provider/v1",
      "api_key_env": "PROVIDER_API_KEY",
      "timeout_seconds": 300,
      "enabled": true,
      "headers": {},
      "description": ""
    },
    {
      "provider_id": "provider2",
      "provider_type": "openai_compatible",
      "base_url": "https://provider2/v1",
      "api_key_env": "PROVIDER_API_KEY_2",
      "timeout_seconds": 300,
      "enabled": true,
      "headers": {},
      "description": ""
    }
  ],
  "models": [
    {
      "client_model": "claude-sonnet-4-6",
      "provider_id": "provider1",
      "upstream_model": "llama-3.1-70b-instruct",
      "enabled": true,
      "extra_body": {},
      "description": "默认 Claude Code 模型"
    },
    {
      "client_model": "claude-sonnet-4-6-alt",
      "provider_id": "nvidia2",
      "upstream_model": "llama-3.1-8b-instruct",
      "enabled": true,
      "extra_body": {},
      "description": "备用线路"
    }
  ],
  "default_client_model": "claude-sonnet-4-6"
}
```

## 关于 token 统计

- 非流式 `/v1/messages`：从上游 `usage.prompt_tokens` / `usage.completion_tokens` 获取
- 流式 `/v1/messages`：依赖上游流式 chunk 返回 `usage`；本项目会自动附加 `stream_options.include_usage = true`
- `/v1/messages/count_tokens`：因为很多 OpenAI-compatible 上游没有单独的 token 计数接口，所以这里发送一个最小化请求，再从响应 `usage.prompt_tokens` 读取输入 token

## 关于 `nvidia2` 这类“找不到供应商”问题

这版已经做了几层收敛：

1. 自动去掉 `provider_id`、`client_model`、`base_url` 前后空格
2. 保存配置时校验 `models[].provider_id` 是否真的存在于 `providers[]`
3. 运行时报错会带出当前启用的 provider 列表，方便你快速定位
4. 前端改成表单式编辑，尽量避免手改 JSON 时出现隐藏空格或引用错误

## 说明

- 这套项目默认把“多供应商”统一为 OpenAI-compatible 协议
- 如果你下一步要混接原生 Anthropic、Gemini、Azure OpenAI 非兼容变体，更建议继续拆 provider adapter
- `package.json` 中的包名未必一定可用；如果 npm 已有同名包，请改名后再发布
