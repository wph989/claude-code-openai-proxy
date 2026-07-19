# Claude Code OpenAI Proxy

面向 Claude Code 和其他 AI Agent 客户端的多供应商 Web 代理。项目只提供 Web 服务和桌面浏览器管理端，不开发原生桌面应用或移动端界面。

## 本次更新

- 将运行时配置统一迁移到单个 SQLite 数据库 `ccop.db`。
- 管理端改为表单和资源级 API，普通页面不再展示原始配置或秘密。
- 保留旧配置的自动迁移能力，仅用于升级，不再作为日常配置方式。
- 自动迁移会保留启用和停用的 Provider、模型及 Key，源文件不会被修改。
- 合并并重写架构与功能说明，移除过时路线图、示例和临时文档。

## 快速开始

```powershell
pnpm add --global claude-code-openai-proxy
ccop start
ccop ui
```

要求 Node.js 22.5+ 和 pnpm。生产模式首次启动会在 `~/.ccop/` 创建环境文件和 `ccop.db`；管理端地址默认是 `http://127.0.0.1:8765/admin`。

详细架构、协议、路由、Key 调度、迁移和安全机制见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 项目地址

https://github.com/wph989/claude-code-openai-proxy

## License

MIT
