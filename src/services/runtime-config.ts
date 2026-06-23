import { settings } from '../config.js';
import { setRuntimeProxyToken } from '../auth.js';
import { ApiKeyRotator, type KeyStateChange } from './api-key-rotator.js';
import { resolveAntiBanConfig, type ResolvedAntiBan } from './anti-ban-config.js';
import type { UsageStore } from './usage-store.js';
import type { KeyStateStore, KeyRuntimeRecord } from './key-state-store.js';
import type { ConfigRepository } from './config/repository.js';
import { JsonFileConfigRepository } from './config/json-file-repository.js';
import { nanoid } from '../utils/nanoid.js';
import {
  KeyRotationStrategy,
  type ApiKeyEntry,
  type KeyQuotaConfig,
  type KeyUsage,
  type ProviderConfig,
  type ResolvedProvider,
  type ResolvedRoute,
  type RuntimeConfig,
  normalizeRuntimeConfig,
  stripRuntimeFromConfig,
  summarizeRuntimeConfig,
  validateRuntimeConfig
} from '../models.js';

/**
 * 运行时配置管理器：
 * - 负责初始化配置文件
 * - 保存配置后立即热生效
 * - 对 provider_id / client_model / 引用关系做强校验
 * - 管理 API Key 状态（错误计数、启用/禁用）并持久化
 *
 * 实际的存储后端通过 ConfigRepository 抽象注入。默认使用 JsonFileConfigRepository
 * （runtime_models.json + runtime_state.json + runtime_usage.json），未来可替换为
 * SqliteConfigRepository 等而无需改动本类。
 */
export class RuntimeConfigManager {
  private repository: ConfigRepository;
  private config: RuntimeConfig = { providers: [], models: [], default_client_model: null };
  private rotators: Map<string, ApiKeyRotator> = new Map();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persisting: Promise<void> | null = null;
  private usageStore: UsageStore | null = null;
  private preloadedUsage: Record<string, KeyUsage> = {};
  private stateStore: KeyStateStore | null = null;
  private preloadedState: Record<string, KeyRuntimeRecord> = {};

  constructor(configPathOrRepository: string | ConfigRepository = settings.configFile) {
    this.repository = typeof configPathOrRepository === 'string'
      ? new JsonFileConfigRepository(configPathOrRepository)
      : configPathOrRepository;
  }

  async init(): Promise<void> {
    try {
      await this.reload();
    } catch {
      await this.ensureDefaultConfig();
      await this.reload();
    }
  }

  getConfig(): RuntimeConfig {
    return structuredClone(this.config);
  }

  async flushRuntimeStores(): Promise<void> {
    // Admin 展示或重建 rotator 前必须先落盘，避免未达批量阈值的 usage 被旧 JSON 覆盖成 0。
    const tasks: Promise<void>[] = [];
    if (this.usageStore) tasks.push(this.usageStore.forceFlush());
    if (this.stateStore) tasks.push(this.stateStore.forceFlush());
    if (tasks.length) await Promise.all(tasks);
  }

  async reload(): Promise<RuntimeConfig> {
    await this.flushRuntimeStores();
    const raw = await this.repository.loadConfig();
    const needsIdRewrite = detectMissingIds(raw);
    const validated = validateRuntimeConfig(raw);

    await this.initStateStore();
    this.applyStateStoreToConfig(validated);

    this.config = validated;
    setRuntimeProxyToken(this.config.proxy_auth_token ?? null);
    await this.initUsageStore();
    this.rebuildRotators();
    await this.reconcileStores();

    if (needsIdRewrite) {
      // 旧版 runtime_models.json 不含 id 字段：normalize 时已现场分配，立刻持久化干净版本。
      await this.persistNow();
    }
    return this.getConfig();
  }

  private async initStateStore(): Promise<void> {
    this.stateStore = this.repository.createKeyStateStore();
    this.preloadedState = await this.stateStore.load();
  }

  /**
   * 将 state 文件中的运行态字段合并回 ApiKeyEntry（按 providerId:id 索引）。
   */
  private applyStateStoreToConfig(config: RuntimeConfig): void {
    if (!this.stateStore) return;
    for (const provider of config.providers) {
      if (!Array.isArray(provider.api_key)) continue;
      for (const entry of provider.api_key) {
        const composite = `${provider.provider_id}:${entry.id}`;
        const record = this.preloadedState[composite];
        if (!record) continue;
        if (record.error_count != null) entry.error_count = record.error_count;
        if (record.disabled_at !== undefined) entry.disabled_at = record.disabled_at ?? null;
        if (record.last_error_at !== undefined) entry.last_error_at = record.last_error_at ?? null;
        if (record.last_error_message !== undefined) entry.last_error_message = record.last_error_message ?? null;
        if (record.auto_disabled_at !== undefined) entry.auto_disabled_at = record.auto_disabled_at ?? null;
        if (record.auto_disabled_at != null) entry.enabled = false;
      }
    }
  }

  private async initUsageStore(): Promise<void> {
    const ab = resolveAntiBanConfig(this.config.anti_ban);
    this.usageStore = this.repository.createUsageStore({
      every_n: ab.quota.persist_every_n_requests,
      critical_threshold: ab.quota.persist_critical_threshold,
      usageFileHint: ab.quota.usage_file
    });
    this.preloadedUsage = await this.usageStore.load();
  }

  /**
   * 启动 / 配置变更后，把 state 和 usage 文件对齐到当前 config 的全量 key 集合。
   * 缺的补默认零值，多的清掉，保证文件可见性等于内存可见性。
   */
  private async reconcileStores(): Promise<void> {
    const desired = new Set<string>();
    for (const p of this.config.providers) {
      const keys = resolveApiKeys(p);
      for (const k of keys) desired.add(`${p.provider_id}:${k.id}`);
    }
    const defaults: KeyRuntimeRecord = {
      error_count: 0,
      disabled_at: null,
      last_error_at: null,
      last_error_message: null,
      auto_disabled_at: null
    };
    const tasks: Promise<void>[] = [];
    if (this.stateStore && this.stateStore.reconcile(desired, defaults)) {
      tasks.push(this.stateStore.forceFlush());
    }
    if (this.usageStore && this.usageStore.reconcile(desired)) {
      tasks.push(this.usageStore.forceFlush());
    }
    if (tasks.length) await Promise.all(tasks);
  }

  async shutdown(): Promise<void> {
    if (this.usageStore) await this.usageStore.forceFlush();
    if (this.stateStore) await this.stateStore.forceFlush();
  }

  async ensureDefaultConfig(): Promise<void> {
    await this.repository.ensureDefaultConfig(buildDefaultRuntimeConfig);
  }

  async saveConfig(raw: RuntimeConfig): Promise<RuntimeConfig> {
    await this.flushRuntimeStores();
    const validated = validateRuntimeConfig(raw);

    if (!this.stateStore) await this.initStateStore();
    // 来自 admin 的 payload 通常不含运行态字段，但保险起见仍走一次合并；同时把 admin 改的 enabled / quota 等带回内存。
    this.applyStateStoreToConfig(validated);

    this.config = validated;
    setRuntimeProxyToken(this.config.proxy_auth_token ?? null);
    await this.initUsageStore();
    this.rebuildRotators();
    await this.reconcileStores();
    await this.persistNow();
    return this.getConfig();
  }

  summary() {
    return summarizeRuntimeConfig(this.config);
  }

  adminView() {
    // 收集所有供应商的运行时状态
    const keyStates: Record<string, unknown[]> = {};
    for (const provider of this.config.providers) {
      const rotator = this.rotators.get(provider.provider_id);
      if (rotator) {
        keyStates[provider.provider_id] = rotator.getKeyStatuses();
      }
    }

    return {
      config: this.getConfig(),
      summary: this.summary(),
      provider_options: this.config.providers.map((item) => ({
        provider_id: item.provider_id,
        label: `${item.provider_id} (${item.enabled !== false ? '启用' : '停用'})`
      })),
      key_states: keyStates  // 新增：所有运行时状态
    };
  }

  listModels(): { id: string; object: 'model'; created: number; owned_by: string }[] {
    return this.config.models
      .filter((item) => item.enabled !== false)
      .map((item) => ({
        id: item.client_model,
        object: 'model' as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: item.provider_id
      }));
  }

  resolveModel(clientModel: string): { route: ResolvedRoute; provider: ResolvedProvider; rotator: ApiKeyRotator } {
    const normalizedModel = String(clientModel || '').trim();

    // 支持模型重名：找到所有匹配的路由，随机选择一个
    const matchedRoutes = this.config.models.filter((item) => item.client_model === normalizedModel && item.enabled !== false);

    if (matchedRoutes.length === 0) {
      throw new Error(`未找到可用的模型映射：${normalizedModel}`);
    }

    // 多个路由时随机选择
    const route = matchedRoutes.length === 1
      ? matchedRoutes[0]
      : matchedRoutes[Math.floor(Math.random() * matchedRoutes.length)];

    const provider = this.config.providers.find((item) => item.provider_id === route.provider_id);

    if (!provider || provider.enabled === false) {
      const enabledProviderIds = this.config.providers.filter((item) => item.enabled !== false).map((item) => item.provider_id);
      throw new Error(`未找到可用的供应商：${route.provider_id}。当前启用的供应商：${enabledProviderIds.join(', ') || '无'}`);
    }

    const apiKeys = resolveApiKeys(provider);
    const autoDisable = provider.auto_disable_on_error !== false;
    const antiBan = resolveAntiBanConfig(provider.anti_ban, this.config.anti_ban);
    const rotator = this.getOrCreateRotator(provider.provider_id, apiKeys, provider.key_rotation_strategy ?? KeyRotationStrategy.round_robin, autoDisable, antiBan);

    const resolvedProvider: ResolvedProvider = {
      provider_id: provider.provider_id,
      provider_type: provider.provider_type,
      base_url: replaceEnv(provider.base_url),
      quota: provider.quota ?? null,
      api_keys: apiKeys,
      key_rotation_strategy: provider.key_rotation_strategy ?? KeyRotationStrategy.round_robin,
      auto_disable_on_error: autoDisable,
      timeout_seconds: provider.timeout_seconds || 300,
      stream_idle_timeout_seconds: provider.stream_idle_timeout_seconds || 120,
      enabled: !!provider.enabled,
      headers: normalizeHeaders(provider.headers || {}),
      anti_ban: antiBan,
      description: provider.description || ''
    };

    const resolvedRoute: ResolvedRoute = {
      client_model: route.client_model,
      provider_id: route.provider_id,
      upstream_model: route.upstream_model,
      enabled: !!route.enabled,
      extra_body: route.extra_body || {},
      description: route.description || ''
    };

    return { route: resolvedRoute, provider: resolvedProvider, rotator };
  }

  private getOrCreateRotator(providerId: string, keys: ApiKeyEntry[], strategy: KeyRotationStrategy, autoDisable: boolean, antiBan: ResolvedAntiBan): ApiKeyRotator {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    const providerQuota = provider?.quota ?? null;
    const existing = this.rotators.get(providerId);
    if (existing && keysEqual(existing.keys, keys) && existing.strategy === strategy && antiBanEqual(existing.antiBan, antiBan)) {
      return existing;
    }
    const rotator = new ApiKeyRotator(keys, strategy, autoDisable, antiBan, providerQuota, settings.keyMaxErrors);
    rotator.onChange = (key, patch) => this.onKeyStateChange(providerId, key, patch);
    this.attachUsageBridge(providerId, rotator);
    this.rotators.set(providerId, rotator);
    return rotator;
  }

  private rebuildRotators(): void {
    this.rotators.clear();
    for (const provider of this.config.providers) {
      const apiKeys = resolveApiKeys(provider);
      if (apiKeys.length === 0) continue;
      const strategy = provider.key_rotation_strategy ?? KeyRotationStrategy.round_robin;
      const autoDisable = provider.auto_disable_on_error !== false;
      const antiBan = resolveAntiBanConfig(provider.anti_ban, this.config.anti_ban);
      this.getOrCreateRotator(provider.provider_id, apiKeys, strategy, autoDisable, antiBan);
    }
  }

  private attachUsageBridge(providerId: string, rotator: ApiKeyRotator): void {
    for (const k of rotator.getKeys()) {
      const ck = `${providerId}:${k.id}`;
      const prior = this.preloadedUsage[ck];
      if (prior) rotator.hydrateUsage(k.key, prior);
    }
    if (this.usageStore) {
      const store = this.usageStore;
      const idByKey = new Map(rotator.getKeys().map((k) => [k.key, k.id]));
      rotator.setUsageListener((key, usage, ratio) => {
        const id = idByKey.get(key);
        if (!id) return;
        const composite = `${providerId}:${id}`;
        // preloadedUsage 是 rebuildRotators 的 hydrate 来源；写 store 时必须同步它，避免重置后旧快照回灌。
        this.preloadedUsage[composite] = { ...usage };
        store.update(composite, usage, ratio);
      });
    }
  }

  private onKeyStateChange(providerId: string, key: string, patch: KeyStateChange): void {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) return;

    // 确保 api_key 已归一化为数组（resolveApiKeys 会处理字符串/环境变量形式）
    const keys = resolveApiKeys(provider);
    const entry = keys.find((k) => k.key === key);
    if (!entry) return;

    // 直接修改 entry（无需重新赋值 provider.api_key，因为 keys 就是 provider.api_key）
    Object.assign(entry, patch);

    // 把运行态字段写入 state 文件；用户配置字段（enabled / note / quota）变化才需要持久化 config。
    const runtimePatch: KeyRuntimeRecord = {};
    if (patch.error_count != null) runtimePatch.error_count = patch.error_count;
    if (patch.disabled_at !== undefined) runtimePatch.disabled_at = patch.disabled_at;
    if (patch.last_error_at !== undefined) runtimePatch.last_error_at = patch.last_error_at;
    if (patch.last_error_message !== undefined) runtimePatch.last_error_message = patch.last_error_message;
    if (patch.auto_disabled_at !== undefined) runtimePatch.auto_disabled_at = patch.auto_disabled_at;

    if (Object.keys(runtimePatch).length > 0 && this.stateStore) {
      const composite = `${providerId}:${entry.id}`;
      this.preloadedState[composite] = { ...(this.preloadedState[composite] ?? {}), ...runtimePatch };
      this.stateStore.update(composite, runtimePatch);
    }

    const userFieldChanged = patch.enabled !== undefined || patch.note !== undefined;
    if (userFieldChanged) {
      this.schedulePersist();
    }
    if (patch.enabled === false || patch.auto_disabled_at !== undefined) {
      void this.flushRuntimeStores().catch((err) => {
        console.error('[config] Key 禁用时持久化运行态失败:', err);
      });
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, 500);
  }

  private async persistNow(): Promise<void> {
    if (this.persisting) return this.persisting;
    this.persisting = (async () => {
      try {
        const { config: cleaned } = stripRuntimeFromConfig(this.config);
        await this.repository.saveConfig(cleaned);
      } catch (err) {
        console.error('[config] 持久化配置失败:', err);
      } finally {
        this.persisting = null;
      }
    })();
    return this.persisting;
  }

  private recordResetState(providerId: string, keyId: string): void {
    const composite = `${providerId}:${keyId}`;
    const reset: KeyRuntimeRecord = {
      error_count: 0,
      disabled_at: null,
      last_error_at: null,
      last_error_message: null,
      auto_disabled_at: null
    };
    this.preloadedState[composite] = reset;
    this.stateStore?.update(composite, reset);
  }

  getKeyStates(providerId: string) {
    const rotator = this.rotators.get(providerId);
    if (!rotator) return [];
    return rotator.getKeyStatuses();
  }

  async updateKeyState(providerId: string, keyIndex: number, patch: Partial<ApiKeyEntry>): Promise<void> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new Error(`未找到供应商：${providerId}`);

    // 确保 api_key 已归一化为数组
    const keys = resolveApiKeys(provider);
    if (keyIndex < 0 || keyIndex >= keys.length) {
      throw new Error(`无效的 key 索引：${keyIndex}`);
    }

    // 直接修改 entry（rotator._keys 指向同一数组，自动同步）
    const entry = keys[keyIndex];
    Object.assign(entry, patch);

    await this.persistNow();
  }

  private getRotatorAndKey(providerId: string, keyIndex: number): { rotator: ApiKeyRotator; key: string } {
    const rotator = this.rotators.get(providerId);
    if (!rotator) throw new Error(`未找到供应商的 rotator：${providerId}`);
    const keys = rotator.getKeys();
    if (keyIndex < 0 || keyIndex >= keys.length) {
      throw new Error(`无效的 key 索引：${keyIndex}`);
    }
    return { rotator, key: keys[keyIndex].key };
  }

  async enableKey(providerId: string, keyIndex: number): Promise<void> {
    const { rotator, key } = this.getRotatorAndKey(providerId, keyIndex);
    rotator.enableKey(key);
    if (this.stateStore) await this.stateStore.forceFlush();
    await this.persistNow();
  }

  async disableKey(providerId: string, keyIndex: number): Promise<void> {
    const { rotator, key } = this.getRotatorAndKey(providerId, keyIndex);
    rotator.disableKey(key);
    if (this.stateStore) await this.stateStore.forceFlush();
    await this.persistNow();
  }

  async resetKey(providerId: string, keyIndex: number): Promise<void> {
    const { rotator, key } = this.getRotatorAndKey(providerId, keyIndex);
    rotator.resetErrorCount(key);
    rotator.resetUsage(key);
    if (this.usageStore) await this.usageStore.forceFlush();
    if (this.stateStore) await this.stateStore.forceFlush();
    await this.persistNow();
  }

  async resetKeyQuota(providerId: string, keyIndex: number): Promise<void> {
    const { rotator, key } = this.getRotatorAndKey(providerId, keyIndex);
    rotator.resetUsage(key);
    if (this.usageStore) await this.usageStore.forceFlush();
  }

  async updateKeyQuota(providerId: string, keyIndex: number, quota: KeyQuotaConfig | null | undefined): Promise<void> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new Error(`未找到供应商：${providerId}`);

    // 直接从配置中获取 Key 数组（不要创建新数组）
    if (!Array.isArray(provider.api_key)) {
      throw new Error(`供应商 ${providerId} 的 api_key 不是数组`);
    }

    if (keyIndex < 0 || keyIndex >= provider.api_key.length) {
      throw new Error(`无效的 key 索引：${keyIndex}`);
    }

    // 直接修改配置中的 quota（保持 undefined / null / {...} 语义）
    const entry = provider.api_key[keyIndex];
    entry.quota = quota;

    // 同步更新 Rotator 的 QuotaGuard
    const rotator = this.rotators.get(providerId);
    if (rotator) {
      rotator.setKeyQuota(entry.key, quota);
    }

    await this.persistNow();
  }

  async addKey(providerId: string, keyValue: string): Promise<ApiKeyEntry> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new Error(`未找到供应商：${providerId}`);

    const trimmed = keyValue.trim();
    if (!trimmed) throw new Error('Key 值不能为空');

    // 确保 api_key 已归一化为数组
    const keys = resolveApiKeys(provider);
    if (keys.some((k) => k.key === trimmed)) {
      throw new Error('该 Key 已存在');
    }

    const newKey: ApiKeyEntry = {
      id: nanoid(),
      key: trimmed,
      enabled: true,
      error_count: 0,
      disabled_at: null,
      last_error_at: null,
      last_error_message: null,
      auto_disabled_at: null
    };

    // 直接 push 到数组（keys 就是 provider.api_key）
    keys.push(newKey);

    this.rebuildRotators();
    await this.reconcileStores();
    await this.persistNow();

    return newKey;
  }

  async resetAllKeys(providerId: string): Promise<number> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new Error(`未找到供应商：${providerId}`);

    const rotator = this.rotators.get(providerId);
    const keys = rotator ? rotator.getKeys() : resolveApiKeys(provider);
    let count = 0;
    for (const entry of keys) {
      if (rotator) {
        rotator.resetErrorCount(entry.key);
      } else {
        entry.error_count = 0;
        entry.enabled = true;
        entry.disabled_at = null;
        entry.auto_disabled_at = null;
        entry.last_error_at = null;
        entry.last_error_message = null;
        this.recordResetState(providerId, entry.id);
      }
      rotator?.resetUsage(entry.key);
      count++;
    }
    // keys 就是 provider.api_key，无需重新赋值
    this.rebuildRotators();
    if (this.usageStore) await this.usageStore.forceFlush();
    if (this.stateStore) await this.stateStore.forceFlush();
    await this.persistNow();
    return count;
  }

  async addKeys(providerId: string, keyValues: string[]): Promise<{ added: string[]; skipped: string[] }> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new Error(`未找到供应商：${providerId}`);

    // 确保 api_key 已归一化为数组
    const keys = resolveApiKeys(provider);
    const existingSet = new Set(keys.map((k) => k.key));
    const added: string[] = [];
    const skipped: string[] = [];

    for (const raw of keyValues) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (existingSet.has(trimmed)) {
        skipped.push(trimmed);
        continue;
      }
      const newKey: ApiKeyEntry = {
        id: nanoid(),
        key: trimmed,
        enabled: true,
        error_count: 0,
        disabled_at: null,
        last_error_at: null,
        last_error_message: null,
        auto_disabled_at: null
      };
      keys.push(newKey);
      existingSet.add(trimmed);
      added.push(trimmed);
    }

    if (added.length > 0) {
      // keys 就是 provider.api_key，无需重新赋值
      this.rebuildRotators();
      await this.reconcileStores();
      await this.persistNow();
    }

    return { added, skipped };
  }

  async deleteKey(providerId: string, keyIndex: number): Promise<void> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new Error(`未找到供应商：${providerId}`);

    // 确保 api_key 已归一化为数组
    const keys = resolveApiKeys(provider);
    if (keyIndex < 0 || keyIndex >= keys.length) {
      throw new Error(`无效的 key 索引：${keyIndex}`);
    }

    const removed = keys[keyIndex];
    keys.splice(keyIndex, 1);
    // keys 就是 provider.api_key，splice 已直接修改

    if (this.stateStore && removed) {
      this.stateStore.remove(`${providerId}:${removed.id}`);
    }

    this.rebuildRotators();
    await this.reconcileStores();
    await this.persistNow();
  }
}

/**
 * 从 Provider 配置中解析出 ApiKeyEntry 数组。
 *
 * 重要变化（重构后）：
 * - 如果 api_key 已经是数组，直接返回原引用（不修改 entry.quota）
 * - 如果是字符串/环境变量，创建新数组并**立即设置回 provider**，然后返回
 * - 保证调用后 provider.api_key 总是数组，且返回值与 provider.api_key 是同一引用
 * - 归一化职责集中在这里，调用方不再需要 `provider.api_key = keys`
 *
 * 配额继承逻辑：
 * - entry.quota === undefined → 使用供应商配额（在 QuotaGuard 层面动态继承）
 * - entry.quota === null → 显式不使用配额
 * - entry.quota === {...} → 使用 Key 自己的配额
 *
 * 这样可以保证：
 * 1. Rotator 持有的 _keys 和 provider.api_key 始终是同一个数组
 * 2. 修改 provider.api_key[i] 会直接影响 Rotator，无需手动同步
 * 3. entry.quota 永远不会被覆盖，保持用户原始配置
 */
function resolveApiKeys(provider: ProviderConfig): ApiKeyEntry[] {
  // 如果已经是数组，直接返回（不修改 entry.quota）
  if (Array.isArray(provider.api_key)) {
    return provider.api_key;
  }

  // 否则创建新数组（字符串或环境变量形式）
  const keys: ApiKeyEntry[] = [];

  if (typeof provider.api_key === 'string') {
    for (const key of provider.api_key.split(',')) {
      const trimmed = key.trim();
      if (trimmed) {
        keys.push({
          id: nanoid(),
          key: trimmed,
          enabled: true,
          error_count: 0,
          disabled_at: null,
          last_error_at: null,
          last_error_message: null,
          auto_disabled_at: null
        });
      }
    }
  }

  if (provider.api_key_env) {
    for (const envName of provider.api_key_env.split(',')) {
      const trimmed = envName.trim();
      if (trimmed) {
        const val = process.env[trimmed]?.trim();
        if (val) {
          keys.push({
            id: nanoid(),
            key: val,
            enabled: true,
            error_count: 0,
            disabled_at: null,
            last_error_at: null,
            last_error_message: null,
            auto_disabled_at: null
          });
        }
      }
    }
  }

  // 去重（不应用供应商配额，保持 undefined）
  const seen = new Set<string>();
  const unique: ApiKeyEntry[] = [];
  for (const entry of keys) {
    if (!seen.has(entry.key)) {
      seen.add(entry.key);
      unique.push(entry);
    }
  }

  // 立即归一化：设置回 provider，后续返回 provider.api_key（保证引用一致）
  provider.api_key = unique as unknown as ApiKeyEntry[];

  // 返回的是 provider.api_key 的引用（不是 unique）
  return provider.api_key;
}

function keysEqual(a: ApiKeyEntry[], b: ApiKeyEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => (
    entry.id === b[i].id
    && entry.key === b[i].key
    && entry.enabled === b[i].enabled
    && JSON.stringify(entry.quota ?? null) === JSON.stringify(b[i].quota ?? null)
  ));
}

function antiBanEqual(a: ResolvedAntiBan, b: ResolvedAntiBan): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function replaceEnv(value: string): string {
  const trimmed = String(value || '').trim();
  if (trimmed.startsWith('${') && trimmed.endsWith('}')) {
    const name = trimmed.slice(2, -1);
    return process.env[name]?.trim() || '';
  }
  return trimmed;
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.trim()] = String(value).trim();
  }
  return result;
}

/**
 * 检测原始 JSON 是否包含缺 id 的 api_key 项；用于决定 reload 后是否要立刻回写干净版本。
 * normalize 会现场补 id，不能用 normalize 后的结果判断。
 */
function detectMissingIds(raw: RuntimeConfig): boolean {
  if (!Array.isArray(raw?.providers)) return false;
  for (const p of raw.providers) {
    if (!Array.isArray(p?.api_key)) continue;
    for (const entry of p.api_key as Array<{ id?: unknown }>) {
      if (!entry || typeof entry.id !== 'string' || entry.id.trim() === '') return true;
    }
  }
  return false;
}

export function buildDefaultRuntimeConfig(): RuntimeConfig {
  return normalizeRuntimeConfig({
    providers: [
      {
        provider_id: 'example-provider',
        provider_type: 'openai_compatible',
        base_url: 'https://api.example.com/v1',
        api_key_env: 'PROVIDER_API_KEY',
        timeout_seconds: 300,
        enabled: true,
        headers: {},
        description: '示例供应商'
      }
    ],
    models: [
      {
        client_model: 'claude-model',
        provider_id: 'example-provider',
        upstream_model: 'your-upstream-model',
        enabled: true,
        extra_body: {},
        description: '示例模型映射'
      }
    ],
    default_client_model: 'claude-model',
    proxy_auth_token: null,
    anti_ban: {
      mode: 'conservative',
      max_concurrent: 1,
      min_interval_ms: 1000,
      rate_limit_delay_min_ms: 5000,
      rate_limit_delay_max_ms: 10000
    }
  });
}
