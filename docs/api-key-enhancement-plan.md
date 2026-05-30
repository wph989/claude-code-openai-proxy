# API Key 增强管理：对象化存储 + 错误计数 + 自动/手动禁用

## Context

当前 `api_key` 以逗号分隔字符串存储，无法追踪单个 key 的错误次数和可用状态。当 key 不可用（如持续 429/401/500）时，轮换器仍会反复向其发送请求，造成无效请求和延迟。本次改造将 `api_key` 改为对象数组格式，每个 key 独立记录状态，支持错误累计自动禁用和手动禁用，避免向不可用的 key 发送请求。

## 设计决策

| 决策项 | 选择 |
|--------|------|
| 字段方案 | 直接修改 `api_key` 字段类型（方案 A） |
| Key 字段 | 增强方案：key, enabled, error_count, disabled_at, last_error_at, last_error_message, auto_disabled_at, note |
| 禁用阈值 | 全局统一配置（.env 中 `KEY_MAX_ERRORS`） |
| 错误范围 | 所有非 2xx 响应 |
| 自动恢复 | 不自动恢复，需手动重新启用 |
| 临时冷却 | 保留现有 on_429 的 60 秒冷却 |
| 向后兼容 | 兼容旧格式（逗号分隔字符串），自动转换 |
| 持久化 | error_count、enabled 等状态写回 config.json |

## 数据结构

### ApiKeyEntry 接口（src/models.ts）

```typescript
interface ApiKeyEntry {
  key: string;                    // API key 值
  enabled: boolean;               // 是否启用（false = 手动或自动禁用）
  error_count: number;            // 累计错误次数
  disabled_at: number | null;     // 手动禁用时间戳（ms），null 表示未手动禁用
  last_error_at: number | null;   // 最后一次错误时间戳（ms）
  last_error_message: string | null; // 最后错误信息
  auto_disabled_at: number | null;   // 自动禁用时间戳（ms），null 表示未被自动禁用
  note?: string;                  // 备注（可选）
}
```

### ProviderConfig.api_key 类型变更（src/models.ts）

```typescript
// 旧：api_key?: string | null;
// 新：api_key?: string | ApiKeyEntry[] | null;
// 读取时自动检测：string → 按逗号拆分包装为对象数组；ApiKeyEntry[] → 直接使用
```

### .env 新增配置（src/config.ts）

```
KEY_MAX_ERRORS=5
```

### 关键设计细节

1. **持久化防抖**：错误触发状态更新时，使用 debounce（500ms）合并写入，避免高频错误时频繁 I/O。手动操作（启用/禁用）立即写入。
2. **pick() 返回类型**：从 `string` 改为 `string | undefined`。上游调用方需处理 `undefined` 情况（返回错误响应）。
3. **markError 统一方法**：合并 `mark429` 到 `markError(key, errorMessage, is429)`。`is429=true` 时额外触发 60 秒临时冷却。
4. **原子写入**：使用 `write-file-atomic` 模式（先写临时文件再 rename），防止集群模式下多 worker 同时写入导致文件损坏。
5. **冷却 vs 禁用优先级**：`pick()` 先检查 `enabled`，再检查临时冷却。被永久禁用的 key 即使冷却期结束也不会被选中。

## 修改文件清单

### 1. `src/models.ts`
- 新增 `ApiKeyEntry` 接口
- 修改 `ProviderConfig.api_key` 类型为 `string | ApiKeyEntry[] | null`
- 修改 `ResolvedProvider.api_keys` 类型为 `ApiKeyEntry[]`（已解析的对象数组）
- 在 `normalizeRuntimeConfig` 中添加 `api_key` 归一化逻辑：
  - string → 按逗号拆分，每个包装为 `{ key, enabled: true, error_count: 0, ...nullFields }`
  - ApiKeyEntry[] → 补全缺省字段
- 更新 `normalizeRuntimeConfig` 中 providers 的映射逻辑

### 2. `src/services/api-key-rotator.ts`
- 构造函数参数从 `string[]` 改为 `ApiKeyEntry[]`
- `pick()` 方法：只从 `enabled === true` 的 key 中选取，跳过被禁用的 key
- `markError(key, errorMessage)` 方法（替代/增强 `mark429`）：
  - 更新 `error_count++`、`last_error_at`、`last_error_message`
  - 如果 `error_count >= maxErrors`，设置 `enabled = false`、`auto_disabled_at = Date.now()`
  - 同时保留 on_429 的 60 秒临时冷却逻辑
- `allCoolingDown()` → 改为 `allUnavailable()`：检查所有 key 要么被禁用，要么在冷却中
- 新增 `getKeys(): ApiKeyEntry[]` 返回当前所有 key 状态
- 新增 `enableKey(key)` / `disableKey(key)` 手动控制方法
- 新增 `resetErrorCount(key)` 重置错误计数
- 新增 `hasAvailableKey()` 判断是否还有可用 key

### 3. `src/services/runtime-config.ts`
- `resolveApiKeys()` 重写：
  - string → 拆分为 `ApiKeyEntry[]`
  - ApiKeyEntry[] → 直接返回
- `getOrCreateRotator()` 参数类型适配
- `rebuildRotators()` 适配
- `resolveModel()` 中 `ResolvedProvider.api_keys` 改为 `ApiKeyEntry[]`
- 新增 `updateKeyState(providerId, key, patch)` 方法：
  - 更新 config 中对应 key 的状态字段
  - 触发 debounce 写回（500ms 合并写入，避免高频 I/O）
  - 更新 rotator 中的状态
- 新增 `updateKeyStateImmediate(providerId, key, patch)` 方法：
  - 用于手动操作，立即写入 config.json
- 新增 `getKeyStates(providerId)` 方法：返回某个 provider 的所有 key 状态
- 持久化使用原子写入（写临时文件 → rename），集群模式下各 worker 共享同一 config.json，rename 操作在 POSIX/NTFS 上是原子的

### 4. `src/services/upstream.ts`
- `postToUpstream()` 中错误处理逻辑修改：
  - 不仅 429，所有非 2xx 响应都调用 `rotator.markError(usedKey, errorMessage)`
  - 429 仍额外触发临时冷却（`mark429` 保留或合并到 `markError`）
- `doFetch()` 返回的 `usedKey` 改为返回 key 字符串（rotator 内部通过 key 值查找对应 entry）

### 5. `src/config.ts`
- `AppSettings` 新增 `keyMaxErrors: number`
- 读取 `KEY_MAX_ERRORS` 环境变量，默认值 5

### 6. `src/routes/admin.ts`
- 新增 API 端点：
  - `GET /api/keys/:providerId` — 获取指定 provider 的所有 key 状态
  - `PUT /api/keys/:providerId/:keyIndex/enable` — 手动启用 key
  - `PUT /api/keys/:providerId/:keyIndex/disable` — 手动禁用 key
  - `PUT /api/keys/:providerId/:keyIndex/reset` — 重置错误计数并启用
- 修改 `PUT /api/config` 的返回值，包含 key 状态摘要

### 7. `src/static/admin.js` + `src/static/index.html` + `src/static/admin.css`
- 管理后台 UI 中为每个 provider 展示 key 列表（状态、错误次数、最后错误信息）
- 提供"启用"/"禁用"/"重置"操作按钮

## 关键逻辑流程

### 请求时的 key 选择

```
rotator.pick()
  → 遍历 enabled === true 的 key
  → 跳过处于 60 秒临时冷却中的 key（仅 on_429 策略）
  → 返回第一个可用 key
  → 如果全部不可用，返回 null（上层返回错误）
```

### 请求失败时的处理

```
upstream 返回非 2xx
  → rotator.markError(key, errorMessage)
    → error_count++
    → 更新 last_error_at, last_error_message
    → 如果 429：设置 60 秒临时冷却
    → 如果 error_count >= KEY_MAX_ERRORS：
      → enabled = false
      → auto_disabled_at = Date.now()
  → runtimeConfigManager.updateKeyState(providerId, key, patch)
    → 更新 config 对象
    → 写回 config.json
```

### 手动启用/禁用

```
管理员操作 UI 按钮
  → PUT /api/keys/:providerId/:keyIndex/enable 或 disable
  → runtimeConfigManager 更新 enabled 字段
  → 如果是 disable：设置 disabled_at = Date.now()
  → 如果是 enable：设置 disabled_at = null，重置 error_count = 0，auto_disabled_at = null
  → 写回 config.json
```

## 向后兼容

`normalizeRuntimeConfig` 中自动转换旧格式：
```
api_key: "sk-aaa,sk-bbb"
→ api_key: [
    { key: "sk-aaa", enabled: true, error_count: 0, disabled_at: null, ... },
    { key: "sk-bbb", enabled: true, error_count: 0, disabled_at: null, ... }
  ]
```

`api_key_env` 保持不变（从环境变量读取，运行时解析为 ApiKeyEntry 对象，不写回配置文件）。

## 验证方案

1. **向后兼容测试**：用旧格式（逗号分隔字符串）配置文件启动，确认自动转换正常
2. **错误计数测试**：模拟非 2xx 响应，确认 error_count 递增
3. **自动禁用测试**：连续触发错误达到阈值，确认 key 被自动禁用
4. **手动禁用/启用测试**：通过 admin API 手动禁用和启用 key
5. **pick 跳过测试**：确认被禁用的 key 不会被 pick() 选中
6. **持久化测试**：触发错误后重启服务，确认 error_count 不丢失
7. **全部不可用测试**：所有 key 都被禁用时，确认返回明确错误信息
8. **on_429 临时冷却测试**：确认 429 仍触发 60 秒冷却，与自动禁用并行工作
