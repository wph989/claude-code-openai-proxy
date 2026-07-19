# NPM 发布指南

本文记录 `claude-code-openai-proxy` 的本地打包与 NPM 发布流程。发布操作会影响公共包，请确认版本号和包内容后再执行。

## 发布前准备

```powershell
git status --short
pnpm check
pnpm test
pnpm view claude-code-openai-proxy version
```

工作区应保持干净。确认 README、版本公告和实际功能一致，并检查 `package.json` 中的 `files`、`bin`、`engines` 与 `publishConfig`。

## 更新版本

项目版本遵循 `主版本.次版本.修订号`（`MAJOR.MINOR.PATCH`）格式。以下示例以当前版本 `0.4.2` 为起点：

| 命令 | 更新结果 | 适用场景 | 本项目示例 |
| --- | --- | --- | --- |
| `pnpm version patch` | `0.4.2` -> `0.4.3` | 向后兼容的问题修复，不增加主要功能 | 修复空响应计数、日志字段错误、UI 显示问题 |
| `pnpm version minor` | `0.4.2` -> `0.5.0` | 向后兼容的新功能或较大功能升级 | 新增 SQLite 自动迁移、路由策略、消耗曲线或管理视图 |
| `pnpm version major` | `0.4.2` -> `1.0.0` | 明确存在不兼容变化，并准备发布稳定主版本 | 删除公开接口、改变 CLI 用法或要求用户手工迁移配置 |

因此，本次公告虽然可以称为“大更新”，但版本计划为 `0.5.0`，在 SemVer 中仍属于 `minor`，应执行：

```powershell
pnpm version minor
```

选择版本级别时遵循以下原则：

- `patch`：现有安装方式、接口、配置和客户端行为保持不变，只修复缺陷。
- `minor`：增加能力但保留现有用法；自动完成且可回退的数据迁移也可以归入该级别。
- `major`：用户必须修改命令、配置、调用方式或数据才能升级，发布说明必须列出迁移步骤。
- 文档、测试或内部重构如果不改变用户可见行为，通常随最近的 `patch` 或 `minor` 一起发布，无需单独升级版本。

`pnpm version` 默认执行以下操作：

1. 更新 `package.json` 中的版本号。
2. 触发项目的 `postversion`，即运行 `pnpm build`。
3. 创建以新版本号为信息的 Git 提交。
4. 创建 `v<version>` 格式的 Git 标签，例如 `v0.5.0`。

默认模式要求工作区干净。若只想先修改版本文件并检查结果，暂不创建提交和标签，应使用：

```powershell
pnpm version minor --no-git-tag-version
```

检查无误后，再按项目约定手工提交并创建标签：

```powershell
git add package.json src/static/views/release-notes.js README.md
git commit -m "发布 0.5.0"
git tag v0.5.0
```

不要重复执行版本命令。若误升版本且尚未发布，应先检查 `git diff`，再人工改回正确版本；不要在不清楚工作区状态时使用破坏性 Git 命令。

同时检查以下位置：

- `package.json` 的版本号。
- `src/static/views/release-notes.js` 的最新公告版本。
- README 的本次更新说明。

## 预览发布包

先检查将要进入 tarball 的文件：

```powershell
pnpm pack --dry-run
```

正式生成本地 tarball：

```powershell
New-Item -ItemType Directory -Force .\tmp\package | Out-Null
pnpm pack --pack-destination .\tmp\package
```

当前包应至少包含 `dist/`、`README.md`、`.env.example` 和必要的包元数据，不应包含 `.env`、`ccop.db`、日志、测试临时文件或真实 Key。

## 安装本地 tarball 验证

在独立临时目录安装，避免全局缓存和当前工作区掩盖缺失文件：

```powershell
New-Item -ItemType Directory -Force .\tmp\install-test | Out-Null
Set-Location .\tmp\install-test
pnpm init
pnpm add ..\package\claude-code-openai-proxy-<version>.tgz
$env:NODE_ENV = 'development'
pnpm exec ccop --version
pnpm exec ccop init-config --sqlite-file .\ccop-test.db
Remove-Item Env:NODE_ENV
Set-Location ..\..
```

还应确认 `dist/static/` 中的管理端文件齐全。测试生成的数据库位于 `tmp/`，验证完成后可删除。

## 登录和发布

```powershell
pnpm login
pnpm whoami
pnpm publish --access public
```

`prepublishOnly` 会再次执行构建。默认不要使用 `--no-git-checks`，让 pnpm 检查分支和工作区状态；只有明确了解原因时才绕过检查。启用 NPM 两步验证时，可追加 `--otp <code>`。

预发布版本示例：

```powershell
pnpm version prerelease --preid beta
pnpm publish --tag beta --access public
```

## 发布后验证

```powershell
pnpm view claude-code-openai-proxy version
pnpm view claude-code-openai-proxy dist-tags
pnpm dlx claude-code-openai-proxy --version
```

等待 NPM 同步后，再从干净环境安装并启动一次管理端。确认无误后推送对应 Git 提交和标签：

```powershell
git push
git push --tags
```

## 发布错误处理

NPM 已发布版本不可覆盖。发现轻微问题时，优先修复后发布新的 patch 版本。需要阻止用户继续安装某个版本时使用弃用说明：

```powershell
pnpm deprecate "claude-code-openai-proxy@<version>" "该版本存在问题，请升级到 <fixed-version>"
```

谨慎使用 `unpublish`；它可能影响已有安装和依赖解析，不应作为常规回滚手段。
