import { settings } from '../config.js';
import { isProxyTokenRequired, setRuntimeProxyToken } from '../auth.js';
import { ConfigConflictError, RuntimeConfigError } from '../errors.js';
import { ApiKeyRotator, type KeyStateChange } from './api-key-rotator.js';
import { resolveAntiBanConfig, type ResolvedAntiBan } from './anti-ban-config.js';
import type { ConfigRepository, KeyStateRepository, UsageRepository } from './config/repository.js';
import type { KeyRuntimeCoordinator } from './key-runtime-coordinator.js';
import { NOOP_ALERTS, type AlertSink } from './alerts.js';
import { ProviderHealthRegistry } from './provider-health.js';
import { RoutingPolicy, normalizeRoutePriority, normalizeRouteWeight } from './routing-policy.js';
import { providerSupportsCapability, resolveProviderCapabilities } from './providers/provider-adapter.js';
import {
  buildAdminRuntimeConfigView,
  buildConfigChangePreview,
  mergeAdminConfigUpdate,
  toAdminKeyView,
  type AdminConfigChange,
  type AdminConfigChangePreview,
} from './admin-config.js';
import { nanoid } from '../utils/nanoid.js';
import {
  KeyRotationStrategy,
  type ApiKeyEntry,
  type KeyQuotaConfig,
  type KeyRuntimeRecord,
  type KeyUsage,
  type ProviderCapability,
  type ProviderConfig,
  type ResolvedProvider,
  type ResolvedRoute,
  type RuntimeConfig,
  normalizeRuntimeConfig,
  stripRuntimeFromConfig,
  summarizeRuntimeConfig,
  validateRuntimeConfig
} from '../models.js';

export interface RuntimeKeyStateEvent {
  providerId: string;
  keyId: string;
  enabled: boolean;
  errorCount: number;
  autoDisabled: boolean;
  revision: number;
}

export interface RuntimeKeyUsageEvent {
  providerId: string;
  keyId: string;
  requestsUsed: number;
  tokensUsed: number;
  ratio: number;
  blocked: boolean;
  costUsd: number;
  reason: string | null;
  revision: number;
}

export interface RuntimeConfigObserver {
  onKeyStateChanged?(event: RuntimeKeyStateEvent): void;
  onKeyUsageChanged?(event: RuntimeKeyUsageEvent): void;
}

export interface AdminConfigHistoryEntry {
  revision: number;
  created_at: number;
  current: boolean;
  summary: ReturnType<typeof summarizeRuntimeConfig>;
  /** 从当前配置回到该版本会发生的字段级变化，不包含任何字段值。 */
  rollback_changes: AdminConfigChange[];
}

/**
 * 运行时配置管理器：
 * - 负责初始化 SQLite 配置
 * - 保存配置后立即热生效
 * - 对 provider_id / client_model / 引用关系做强校验
 * - 管理 API Key 状态（错误计数、启用/禁用）并持久化
 *
 * 实际存储通过 ConfigRepository 注入；生产入口只创建 SQLite 实现，JSON 读取仅供
 * 一次性迁移工具使用，避免运行时出现两套状态语义。
 */
export class RuntimeConfigManager {
  private repository: ConfigRepository;
  private config: RuntimeConfig = { providers: [], models: [], default_client_model: null };
  private rotators: Map<string, ApiKeyRotator> = new Map();
  private usageStore: UsageRepository | null = null;
  private preloadedUsage: Record<string, KeyUsage> = {};
  private stateStore: KeyStateRepository | null = null;
  private preloadedState: Record<string, KeyRuntimeRecord> = {};
  private readonly routingPolicy: RoutingPolicy;
  private observer: RuntimeConfigObserver = {};
  private providerHealth: ProviderHealthRegistry | null = null;
  private readonly keyRuntimeCoordinator: KeyRuntimeCoordinator | null;
  private alertSink: AlertSink = NOOP_ALERTS;
  private initialized = false;
  private mutationTail: Promise<void> = Promise.resolve();
  private shutdownComplete = false;

  constructor(
    repository: ConfigRepository,
    randomSource: () => number = Math.random,
  ) {
    this.repository = repository;
    this.keyRuntimeCoordinator = this.repository.createKeyRuntimeCoordinator?.() ?? null;
    this.routingPolicy = new RoutingPolicy(randomSource);
  }

  async init(): Promise<void> {
    try {
      await this.reload();
    } catch (error) {
      // 只有配置行尚未初始化时创建默认配置；数据库损坏、权限不足或校验失败必须直接暴露。
      if (!isMissingFileError(error)) throw error;
      await this.ensureDefaultConfig();
      await this.reload();
    }
    this.initialized = true;
  }

  isReady(): boolean {
    return this.initialized;
  }

  setObserver(observer: RuntimeConfigObserver): void {
    this.observer = observer;
  }

  setProviderHealth(providerHealth: ProviderHealthRegistry): void {
    this.providerHealth = providerHealth;
  }

  setAlertSink(alertSink: AlertSink): void {
    this.alertSink = alertSink;
  }

  resolveProvider(providerId: string): ResolvedProvider {
    const provider = this.config.providers.find((item) => item.provider_id === providerId);
    if (!provider) throw new RuntimeConfigError(`未找到供应商：${providerId}`);
    this.providerHealth?.configure(providerId, provider.circuit_breaker);
    const apiKeys = resolveApiKeys(provider);
    const autoDisable = provider.auto_disable_on_error !== false;
    const antiBan = resolveAntiBanConfig(provider.anti_ban, this.config.anti_ban);
    return this.toResolvedProvider(provider, apiKeys, autoDisable, antiBan);
  }

  getConfig(): RuntimeConfig {
    return structuredClone(this.config);
  }

  getRevision(): number {
    return this.config.revision ?? 1;
  }

  isProxyAuthTokenConfigured(): boolean {
    return isProxyTokenRequired();
  }

  getDefaultClientModel(): string | null {
    // 请求热路径只需要默认模型名，避免为一个字符串深拷贝包含全部 Key 的配置。
    return this.config.default_client_model ?? null;
  }

  async flushRuntimeStores(): Promise<void> {
    // SQLite 写入会在事务返回前提交；统一保留该边界，便于管理端读取到完整快照。
    const tasks: Promise<void>[] = [];
    if (this.usageStore) tasks.push(this.usageStore.forceFlush());
    if (this.stateStore) tasks.push(this.stateStore.forceFlush());
    if (tasks.length) await Promise.all(tasks);
  }

  async reload(): Promise<RuntimeConfig> {
    return this.serializeMutation(() => this.reloadUnlocked());
  }

  /** SQLite Worker 在请求入口调用；只有 revision 前进时才重建内存视图。 */
  async refreshIfStale(): Promise<boolean> {
    if (!this.repository.getConfigRevision) return false;
    return this.serializeMutation(async () => {
      const persistedRevision = await this.repository.getConfigRevision?.();
      if (persistedRevision == null || persistedRevision <= this.getRevision()) return false;
      await this.reloadUnlocked();
      return true;
    });
  }

  private async reloadUnlocked(): Promise<RuntimeConfig> {
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
      // 迁移前的配置可能缺少稳定 ID；标准化后立即写回 SQLite，避免每次启动重新生成。
      const baseRevision = this.getRevision();
      this.touchRevision();
      await this.persistNow(baseRevision);
    }
    return this.getConfig();
  }

  private async initStateStore(): Promise<void> {
    this.stateStore = this.repository.createKeyStateStore();
    this.preloadedState = await this.stateStore.load();
  }

  /**
   * 将 SQLite state 行中的运行态字段合并回 ApiKeyEntry（按 providerId:id 索引）。
   */
  private applyStateStoreToConfig(config: RuntimeConfig): void {
    if (!this.stateStore) return;
    for (const provider of config.providers) {
      if (!Array.isArray(provider.api_key)) continue;
      for (const entry of provider.api_key) {
        const composite = `${provider.provider_id}:${entry.id}`;
        const record = this.preloadedState[composite];
        if (!record) continue;
        if (record.enabled !== undefined) entry.enabled = record.enabled;
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
    this.usageStore = this.repository.createUsageStore();
    this.preloadedUsage = await this.usageStore.load();
  }

  /**
   * 启动 / 配置变更后，把 SQLite 中的 state 和 usage 行对齐到当前 config 的全量 Key 集合。
   * 缺的补默认零值，多的清掉，保证数据库可见性等于内存可见性。
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
    if (this.shutdownComplete) return;
    this.shutdownComplete = true;
    await this.mutationTail;
    this.initialized = false;
    // 先停止自动恢复等后台回调，防止关闭期间又产生新的延迟写入；在途请求应由上层先关闭服务并等待完成。
    for (const rotator of this.rotators.values()) rotator.dispose();
    if (this.usageStore) await this.usageStore.forceFlush();
    if (this.stateStore) await this.stateStore.forceFlush();
    await this.repository.close?.();
  }

  async ensureDefaultConfig(): Promise<void> {
    await this.repository.ensureDefaultConfig(buildDefaultRuntimeConfig);
  }

  async saveConfig(raw: RuntimeConfig, expectedRevision?: number): Promise<RuntimeConfig> {
    return this.serializeMutation(() => this.saveConfigUnlocked(raw, expectedRevision));
  }

  private async saveConfigUnlocked(raw: RuntimeConfig, expectedRevision?: number): Promise<RuntimeConfig> {
    if (expectedRevision !== undefined) this.assertRevision(expectedRevision);
    const baseRevision = this.getRevision();
    await this.flushRuntimeStores();
    let validated: RuntimeConfig;
    try {
      validated = validateRuntimeConfig({ ...raw, revision: this.getRevision() + 1 });
    } catch (error) {
      // Admin 提交的配置校验失败属于客户端输入问题；只在保存边界转换，启动加载失败仍走原有恢复流程。
      throw new RuntimeConfigError(error instanceof Error ? error.message : '运行时配置无效。');
    }

    if (!this.stateStore) await this.initStateStore();
    // 来自 admin 的 payload 通常不含运行态字段，但保险起见仍走一次合并；同时把 admin 改的 enabled / quota 等带回内存。
    this.applyStateStoreToConfig(validated);

    const previousConfig = this.config;
    try {
      this.config = validated;
      setRuntimeProxyToken(this.config.proxy_auth_token ?? null);
      await this.initUsageStore();
      this.rebuildRotators();
      await this.reconcileStores();
      await this.persistNow(baseRevision);
    } catch (error) {
      // 管理端已经收到保存失败时，内存不能继续运行未落盘配置，否则重启前后行为会不一致。
      await this.recoverAfterFailedMutation(previousConfig, error);
      throw error;
    }
    return this.getConfig();
  }

  async saveAdminConfig(raw: unknown, expectedRevision: number): Promise<RuntimeConfig> {
    return this.saveConfig(mergeAdminConfigUpdate(this.config, raw), expectedRevision);
  }

  previewAdminConfig(raw: unknown, expectedRevision: number): AdminConfigChangePreview {
    this.assertRevision(expectedRevision);
    const merged = mergeAdminConfigUpdate(this.config, raw);
    let validated: RuntimeConfig;
    try {
      validated = validateRuntimeConfig({ ...merged, revision: this.getRevision() });
    } catch (error) {
      throw new RuntimeConfigError(error instanceof Error ? error.message : '运行时配置无效。');
    }
    return buildConfigChangePreview(this.config, validated);
  }

  async listConfigHistory(limit = 20): Promise<AdminConfigHistoryEntry[]> {
    if (!this.repository.listConfigHistory) return [];
    const records = await this.repository.listConfigHistory(limit);
    return records.map((record) => ({
      revision: record.revision,
      created_at: record.createdAt,
      current: record.revision === this.getRevision(),
      summary: summarizeRuntimeConfig(record.config),
      rollback_changes: buildConfigChangePreview(this.config, record.config).changes,
    }));
  }

  async rollbackConfig(targetRevision: number, expectedRevision: number): Promise<RuntimeConfig> {
    if (!this.repository.loadConfigHistory) {
      throw new RuntimeConfigError('当前存储后端不支持配置历史。');
    }
    return this.serializeConfigMutation(async (baseRevision) => {
      this.assertRevision(expectedRevision);
      const record = await this.repository.loadConfigHistory?.(targetRevision);
      if (!record) throw new RuntimeConfigError(`未找到配置历史 revision=${targetRevision}。`);
      const restored = validateRuntimeConfig({
        ...structuredClone(record.config),
        // 回滚是一次新写入，revision 必须继续单调递增，不能倒退到历史值。
        revision: baseRevision + 1,
      });
      this.config = restored;
      setRuntimeProxyToken(this.config.proxy_auth_token ?? null);
      await this.initUsageStore();
      this.rebuildRotators();
      await this.reconcileStores();
      await this.persistNow(baseRevision);
      return this.getConfig();
    });
  }

  async updateProxyAuthToken(token: string | null, expectedRevision: number): Promise<void> {
    return this.serializeConfigMutation(async (baseRevision) => {
      this.assertRevision(expectedRevision);
      this.config.proxy_auth_token = token;
      this.touchRevision();
      setRuntimeProxyToken(token);
      await this.persistNow(baseRevision);
    });
  }

  summary() {
    return summarizeRuntimeConfig(this.config);
  }

  adminView() {
    const keyStates: Record<string, ReturnType<ApiKeyRotator['getKeyStatuses']>> = {};
    for (const provider of this.config.providers) {
      const rotator = this.rotators.get(provider.provider_id);
      if (rotator) {
        keyStates[provider.provider_id] = rotator.getKeyStatuses();
      }
    }

    return {
      config: buildAdminRuntimeConfigView(this.config, keyStates, this.providerHealth ?? undefined),
      revision: this.getRevision(),
      proxy_auth_token_configured: this.isProxyAuthTokenConfigured(),
      summary: this.summary(),
      runtime_settings: {
        key_auto_disable: settings.keyAutoDisable,
        key_max_errors: this.config.key_max_errors ?? settings.keyMaxErrors,
        webhook_alerts_configured: Boolean(settings.alertWebhookUrl),
        webhook_budget_threshold: settings.alertBudgetThreshold,
      },
      provider_options: this.config.providers.map((item) => ({
        provider_id: item.provider_id,
        label: `${item.provider_id} (${item.enabled !== false ? '启用' : '停用'})`
      })),
      key_states: Object.fromEntries(this.config.providers.map((provider) => {
        const configuredIds = new Set(Array.isArray(provider.api_key)
          ? provider.api_key.map((entry) => entry.id)
          : []);
        return [
          provider.provider_id,
          (keyStates[provider.provider_id] || []).map((entry) => toAdminKeyView(
            entry,
            configuredIds.has(entry.id) ? 'config' : 'environment',
          )),
        ];
      }))
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

  resolveModel(
    clientModel: string,
    requiredCapability?: ProviderCapability,
  ): { route: ResolvedRoute; provider: ResolvedProvider; rotator: ApiKeyRotator } {
    const normalizedModel = String(clientModel || '').trim();

    // 先只筛选路由开关；供应商和 Key 的可用性必须在随机选择前完成，避免抽中停用候选后随机失败。
    const matchedRoutes = this.config.models.filter((item) => item.client_model === normalizedModel && item.enabled !== false);

    if (matchedRoutes.length === 0) {
      throw new Error(`未找到可用的模型映射：${normalizedModel}`);
    }

    let enabledProviderRoutes = 0;
    let capabilityEligibleRoutes = 0;
    let circuitBlockedRoutes = 0;
    const candidates = matchedRoutes.flatMap((route) => {
      const provider = this.config.providers.find((item) => item.provider_id === route.provider_id);
      if (!provider || provider.enabled === false) return [];
      enabledProviderRoutes += 1;
      if (requiredCapability && !providerSupportsCapability(provider, requiredCapability)) return [];
      capabilityEligibleRoutes += 1;
      this.providerHealth?.configure(provider.provider_id, provider.circuit_breaker);
      if (this.providerHealth && !this.providerHealth.isAvailable(provider.provider_id)) {
        circuitBlockedRoutes += 1;
        return [];
      }
      const apiKeys = resolveApiKeys(provider);
      if (apiKeys.length === 0) return [];
      const autoDisable = provider.auto_disable_on_error !== false;
      const antiBan = resolveAntiBanConfig(provider.anti_ban, this.config.anti_ban);
      const rotator = this.getOrCreateRotator(
        provider.provider_id,
        apiKeys,
        provider.key_rotation_strategy ?? KeyRotationStrategy.round_robin,
        autoDisable,
        antiBan,
      );
      const hasUsableKey = rotator.getKeyStatuses().some((key) => key.enabled && !key.quota_blocked);
      return hasUsableKey ? [{ route, provider, apiKeys, rotator, autoDisable, antiBan }] : [];
    });

    if (candidates.length === 0) {
      if (requiredCapability && capabilityEligibleRoutes === 0) {
        throw new Error(`当前模型没有启用支持 ${capabilityLabel(requiredCapability)} 的供应商。`);
      }
      if (capabilityEligibleRoutes > 0 && circuitBlockedRoutes === capabilityEligibleRoutes) {
        throw new Error(`模型 ${normalizedModel} 的供应商均处于熔断冷却中，请稍后重试。`);
      }
      throw new Error(`模型 ${normalizedModel} 没有启用且具备可用 Key 的供应商。`);
    }

    const selected = this.routingPolicy.select(candidates);
    const { route, provider, apiKeys, rotator, autoDisable, antiBan } = selected;
    const resolvedProvider = this.toResolvedProvider(provider, apiKeys, autoDisable, antiBan);

    const resolvedRoute: ResolvedRoute = {
      route_id: route.route_id || `${route.provider_id}:${route.client_model}:${route.upstream_model}`,
      client_model: route.client_model,
      provider_id: route.provider_id,
      upstream_model: route.upstream_model,
      priority: normalizeRoutePriority(route.priority),
      weight: normalizeRouteWeight(route.weight),
      enabled: route.enabled !== false,
      extra_body: route.extra_body || {},
      description: route.description || ''
    };

    return { route: resolvedRoute, provider: resolvedProvider, rotator };
  }

  private toResolvedProvider(
    provider: ProviderConfig,
    apiKeys: ApiKeyEntry[],
    autoDisable: boolean,
    antiBan: ResolvedAntiBan,
  ): ResolvedProvider {
    return {
      provider_id: provider.provider_id,
      provider_type: provider.provider_type,
      base_url: replaceEnv(provider.base_url),
      capabilities: resolveProviderCapabilities(provider.provider_type, provider.capabilities),
      quota: provider.quota ?? null,
      api_keys: apiKeys,
      key_rotation_strategy: provider.key_rotation_strategy ?? KeyRotationStrategy.round_robin,
      auto_disable_on_error: autoDisable,
      auto_recover_minutes: provider.auto_recover_minutes ?? 0,
      timeout_seconds: provider.timeout_seconds || 300,
      stream_idle_timeout_seconds: provider.stream_idle_timeout_seconds || 120,
      enabled: provider.enabled !== false,
      headers: normalizeHeaders(provider.headers || {}),
      anti_ban: antiBan,
      circuit_breaker: provider.circuit_breaker === null ? null : provider.circuit_breaker ?? {},
      description: provider.description || '',
    };
  }

  private getOrCreateRotator(providerId: string, keys: ApiKeyEntry[], strategy: KeyRotationStrategy, autoDisable: boolean, antiBan: ResolvedAntiBan): ApiKeyRotator {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    const providerQuota = provider?.quota ?? null;
    const existing = this.rotators.get(providerId);
    if (existing && keysEqual(existing.keys, keys) && existing.strategy === strategy && antiBanEqual(existing.antiBan, antiBan)) {
      return existing;
    }
    // 运行时配置优先于环境变量；全局开关是总闸，供应商只能在总闸开启时进一步关闭自身自动禁用。
    const keyMaxErrors = this.config.key_max_errors ?? settings.keyMaxErrors;
    const effectiveAutoDisable = settings.keyAutoDisable && autoDisable;
    const rotator = new ApiKeyRotator(
      keys,
      strategy,
      effectiveAutoDisable,
      antiBan,
      providerQuota,
      keyMaxErrors,
      provider?.auto_recover_minutes ?? 0,
      this.keyRuntimeCoordinator ? {
        coordinator: this.keyRuntimeCoordinator,
        providerId,
      } : null,
    );
    rotator.onChange = (key, patch) => this.onKeyStateChange(providerId, key, patch);
    this.attachUsageBridge(providerId, rotator);
    this.rotators.set(providerId, rotator);
    return rotator;
  }

  private rebuildRotators(): void {
    // 配置重载后旧 rotator 不再可达，先释放其自动恢复定时器，避免修改已经淘汰的 Key 引用。
    for (const rotator of this.rotators.values()) rotator.dispose();
    this.rotators.clear();
    for (const provider of this.config.providers) {
      this.providerHealth?.configure(provider.provider_id, provider.circuit_breaker);
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
    const store = this.usageStore;
    const idByKey = new Map(rotator.getKeys().map((k) => [k.key, k.id]));
    rotator.setUsageListener((key, usage, ratio) => {
      const id = idByKey.get(key);
      if (!id) return;
      if (store && !this.keyRuntimeCoordinator) {
        const composite = `${providerId}:${id}`;
        // preloadedUsage 是 rebuildRotators 的 hydrate 来源；写 store 时必须同步它，避免重置后旧快照回灌。
        this.preloadedUsage[composite] = { ...usage };
        store.update(composite, usage, ratio);
      }
      const snapshot = rotator.getQuotaSnapshot(key);
      const event: RuntimeKeyUsageEvent = {
        providerId,
        keyId: id,
        requestsUsed: usage.requests_used,
        tokensUsed: usage.tokens_used,
        ratio,
        blocked: snapshot.blocked,
        costUsd: usage.cost_usd ?? 0,
        reason: snapshot.reason,
        revision: this.getRevision(),
      };
      this.notifyObserver(() => this.observer.onKeyUsageChanged?.(event));
      this.alertSink.keyBudget({
        providerId,
        usage,
        ratio,
        blocked: snapshot.blocked,
        reason: snapshot.reason,
      });
    });
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

    // 无共享协调器时才回退写入状态仓储；生产 SQLite 会在 Rotator 内直接提交事务。
    const runtimePatch: KeyRuntimeRecord = {};
    if (patch.error_count != null) runtimePatch.error_count = patch.error_count;
    if (patch.disabled_at !== undefined) runtimePatch.disabled_at = patch.disabled_at;
    if (patch.last_error_at !== undefined) runtimePatch.last_error_at = patch.last_error_at;
    if (patch.last_error_message !== undefined) runtimePatch.last_error_message = patch.last_error_message;
    if (patch.auto_disabled_at !== undefined) runtimePatch.auto_disabled_at = patch.auto_disabled_at;

    if (Object.keys(runtimePatch).length > 0 && this.stateStore && !this.keyRuntimeCoordinator) {
      const composite = `${providerId}:${entry.id}`;
      this.preloadedState[composite] = { ...(this.preloadedState[composite] ?? {}), ...runtimePatch };
      this.stateStore.update(composite, runtimePatch);
    }

    if (patch.enabled === false || patch.auto_disabled_at !== undefined) {
      void this.flushRuntimeStores().catch((err) => {
        console.error('[config] Key 禁用时持久化运行态失败:', err);
      });
    }
    this.notifyObserver(() => this.observer.onKeyStateChanged?.({
      providerId,
      keyId: entry.id,
      enabled: entry.enabled !== false,
      errorCount: entry.error_count,
      autoDisabled: entry.auto_disabled_at != null,
      revision: this.getRevision(),
    }));
  }

  private notifyObserver(callback: () => void): void {
    try {
      // 管理事件属于旁路观测，失败时不能改变 Key 状态机或请求结果。
      callback();
    } catch {
      // ignore observer failures
    }
  }

  private serializeMutation<T>(callback: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(callback, callback);
    // 队列尾部吞掉单次失败，后续管理请求仍可继续执行；原 Promise 保留错误给当前调用方。
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private serializeConfigMutation<T>(callback: (baseRevision: number) => Promise<T>): Promise<T> {
    return this.serializeMutation(async () => {
      const previousConfig = structuredClone(this.config);
      const baseRevision = this.getRevision();
      try {
        return await callback(baseRevision);
      } catch (error) {
        await this.recoverAfterFailedMutation(previousConfig, error);
        throw error;
      }
    });
  }

  private async persistNow(expectedRevision?: number): Promise<void> {
    const { config: cleaned } = stripRuntimeFromConfig(this.config);
    await this.repository.saveConfig(cleaned, expectedRevision);
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

  getAdminKeyStates(providerId: string) {
    const provider = this.config.providers.find((item) => item.provider_id === providerId);
    if (!provider) throw new RuntimeConfigError(`未找到供应商：${providerId}`);
    const configuredIds = new Set(Array.isArray(provider.api_key)
      ? provider.api_key.map((entry) => entry.id)
      : []);
    return this.getKeyStates(providerId).map((entry) => toAdminKeyView(
      entry,
      configuredIds.has(entry.id) ? 'config' : 'environment',
    ));
  }

  exportKeys(providerId: string): string[] {
    const provider = this.config.providers.find((item) => item.provider_id === providerId);
    if (!provider) throw new RuntimeConfigError(`未找到供应商：${providerId}`);
    return resolveApiKeys(provider).map((entry) => entry.key);
  }

  private requireKeyId(providerId: string, keyId: string): string {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new RuntimeConfigError(`未找到供应商：${providerId}`);
    const normalized = String(keyId).trim();
    if (resolveApiKeys(provider).some((entry) => entry.id === normalized)) return normalized;
    throw new RuntimeConfigError(`未找到 Key：${normalized || '<空>'}`);
  }

  async updateKeyState(providerId: string, keyId: string, patch: Partial<ApiKeyEntry>): Promise<void> {
    return this.serializeConfigMutation((baseRevision) => (
      this.updateKeyStateUnlocked(providerId, keyId, patch, baseRevision)
    ));
  }

  private async updateKeyStateUnlocked(providerId: string, keyId: string, patch: Partial<ApiKeyEntry>, baseRevision: number): Promise<void> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new RuntimeConfigError(`未找到供应商：${providerId}`);
    const resolvedKeyId = this.requireKeyId(providerId, keyId);
    const entry = resolveApiKeys(provider).find((key) => key.id === resolvedKeyId);
    if (!entry) throw new RuntimeConfigError(`未找到 Key：${resolvedKeyId}`);

    // 直接修改 entry（rotator._keys 指向同一数组，自动同步）
    Object.assign(entry, patch);
    this.touchRevision();
    await this.persistNow(baseRevision);
  }

  private getRotatorAndKey(providerId: string, keyId: string): { rotator: ApiKeyRotator; key: string; keyId: string } {
    const rotator = this.rotators.get(providerId);
    if (!rotator) throw new RuntimeConfigError(`未找到供应商的 rotator：${providerId}`);
    const resolvedKeyId = this.requireKeyId(providerId, keyId);
    const entry = rotator.getKeys().find((key) => key.id === resolvedKeyId);
    if (!entry) throw new RuntimeConfigError(`未找到 Key：${resolvedKeyId}`);
    return { rotator, key: entry.key, keyId: resolvedKeyId };
  }

  async enableKey(providerId: string, keyId: string): Promise<void> {
    return this.serializeConfigMutation((baseRevision) => (
      this.enableKeyUnlocked(providerId, keyId, baseRevision)
    ));
  }

  private async enableKeyUnlocked(providerId: string, keyId: string, baseRevision: number): Promise<void> {
    const { rotator, key } = this.getRotatorAndKey(providerId, keyId);
    rotator.enableKey(key);
    this.touchRevision();
    if (this.stateStore) await this.stateStore.forceFlush();
    await this.persistNow(baseRevision);
  }

  async disableKey(providerId: string, keyId: string): Promise<void> {
    return this.serializeConfigMutation((baseRevision) => (
      this.disableKeyUnlocked(providerId, keyId, baseRevision)
    ));
  }

  private async disableKeyUnlocked(providerId: string, keyId: string, baseRevision: number): Promise<void> {
    const { rotator, key } = this.getRotatorAndKey(providerId, keyId);
    rotator.disableKey(key);
    this.touchRevision();
    if (this.stateStore) await this.stateStore.forceFlush();
    await this.persistNow(baseRevision);
  }

  async resetKey(providerId: string, keyId: string): Promise<void> {
    return this.serializeConfigMutation((baseRevision) => (
      this.resetKeyUnlocked(providerId, keyId, baseRevision)
    ));
  }

  private async resetKeyUnlocked(providerId: string, keyId: string, baseRevision: number): Promise<void> {
    const { rotator, key } = this.getRotatorAndKey(providerId, keyId);
    rotator.resetErrorCount(key);
    rotator.resetUsage(key);
    this.touchRevision();
    if (this.usageStore) await this.usageStore.forceFlush();
    if (this.stateStore) await this.stateStore.forceFlush();
    await this.persistNow(baseRevision);
  }

  async resetKeyQuota(providerId: string, keyId: string): Promise<void> {
    return this.serializeMutation(() => this.resetKeyQuotaUnlocked(providerId, keyId));
  }

  private async resetKeyQuotaUnlocked(providerId: string, keyId: string): Promise<void> {
    const { rotator, key } = this.getRotatorAndKey(providerId, keyId);
    rotator.resetUsage(key);
    if (this.usageStore) await this.usageStore.forceFlush();
  }

  async updateKeyQuota(providerId: string, keyId: string, quota: KeyQuotaConfig | null | undefined): Promise<void> {
    return this.serializeConfigMutation((baseRevision) => (
      this.updateKeyQuotaUnlocked(providerId, keyId, quota, baseRevision)
    ));
  }

  private async updateKeyQuotaUnlocked(providerId: string, keyId: string, quota: KeyQuotaConfig | null | undefined, baseRevision: number): Promise<void> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new RuntimeConfigError(`未找到供应商：${providerId}`);

    // 直接从配置中获取 Key 数组（不要创建新数组）
    if (!Array.isArray(provider.api_key)) {
      throw new RuntimeConfigError(`供应商 ${providerId} 的 api_key 不是数组`);
    }

    // 直接修改配置中的 quota（保持 undefined / null / {...} 语义）
    const resolvedKeyId = this.requireKeyId(providerId, keyId);
    const entry = provider.api_key.find((key) => key.id === resolvedKeyId);
    if (!entry) throw new RuntimeConfigError(`Key ${resolvedKeyId} 由环境变量提供，不能写入独立配额。`);
    entry.quota = quota;

    // 同步更新 Rotator 的 QuotaGuard
    const rotator = this.rotators.get(providerId);
    if (rotator) {
      rotator.setKeyQuota(entry.key, quota);
    }

    this.touchRevision();
    await this.persistNow(baseRevision);
  }

  async addKey(providerId: string, keyValue: string): Promise<ApiKeyEntry> {
    return this.serializeConfigMutation((baseRevision) => (
      this.addKeyUnlocked(providerId, keyValue, baseRevision)
    ));
  }

  private async addKeyUnlocked(providerId: string, keyValue: string, baseRevision: number): Promise<ApiKeyEntry> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new RuntimeConfigError(`未找到供应商：${providerId}`);

    const trimmed = keyValue.trim();
    if (!trimmed) throw new RuntimeConfigError('Key 值不能为空');

    const resolvedKeys = resolveApiKeys(provider);
    if (resolvedKeys.some((k) => k.key === trimmed)) {
      throw new RuntimeConfigError('该 Key 已存在');
    }
    const keys = ensureConfiguredApiKeys(provider);

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
    invalidateResolvedApiKeys(provider);

    this.touchRevision();
    this.rebuildRotators();
    await this.reconcileStores();
    await this.persistNow(baseRevision);

    return newKey;
  }

  async resetAllKeys(providerId: string): Promise<number> {
    return this.serializeConfigMutation((baseRevision) => (
      this.resetAllKeysUnlocked(providerId, baseRevision)
    ));
  }

  private async resetAllKeysUnlocked(providerId: string, baseRevision: number): Promise<number> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new RuntimeConfigError(`未找到供应商：${providerId}`);

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
    this.touchRevision();
    this.rebuildRotators();
    if (this.usageStore) await this.usageStore.forceFlush();
    if (this.stateStore) await this.stateStore.forceFlush();
    await this.persistNow(baseRevision);
    return count;
  }

  async addKeys(providerId: string, keyValues: string[]): Promise<{ added: string[]; skipped: string[] }> {
    return this.serializeConfigMutation((baseRevision) => (
      this.addKeysUnlocked(providerId, keyValues, baseRevision)
    ));
  }

  private async addKeysUnlocked(providerId: string, keyValues: string[], baseRevision: number): Promise<{ added: string[]; skipped: string[] }> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new RuntimeConfigError(`未找到供应商：${providerId}`);

    const existingSet = new Set(resolveApiKeys(provider).map((k) => k.key));
    const keys = ensureConfiguredApiKeys(provider);
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
      invalidateResolvedApiKeys(provider);
      this.touchRevision();
      this.rebuildRotators();
      await this.reconcileStores();
      await this.persistNow(baseRevision);
    }

    return { added, skipped };
  }

  async deleteKey(providerId: string, keyId: string): Promise<void> {
    return this.serializeConfigMutation((baseRevision) => (
      this.deleteKeyUnlocked(providerId, keyId, baseRevision)
    ));
  }

  private async deleteKeyUnlocked(providerId: string, keyId: string, baseRevision: number): Promise<void> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new RuntimeConfigError(`未找到供应商：${providerId}`);

    const resolvedKeyId = this.requireKeyId(providerId, keyId);
    if (!Array.isArray(provider.api_key)) {
      throw new RuntimeConfigError(`Key ${resolvedKeyId} 由环境变量提供，不能从配置中删除。`);
    }
    const keyIndex = provider.api_key.findIndex((entry) => entry.id === resolvedKeyId);
    if (keyIndex < 0) throw new RuntimeConfigError(`未找到 Key：${resolvedKeyId}`);
    const removed = provider.api_key[keyIndex];
    provider.api_key.splice(keyIndex, 1);
    invalidateResolvedApiKeys(provider);

    if (this.stateStore && removed) {
      this.stateStore.remove(`${providerId}:${removed.id}`);
    }

    this.touchRevision();
    this.rebuildRotators();
    await this.reconcileStores();
    await this.persistNow(baseRevision);
  }

  private assertRevision(expectedRevision: number): void {
    if (expectedRevision !== this.getRevision()) {
      throw new ConfigConflictError(
        `配置已被其他会话更新（当前 revision=${this.getRevision()}），请重新加载后再保存。`,
        this.getRevision(),
      );
    }
  }

  private touchRevision(): void {
    this.config.revision = this.getRevision() + 1;
  }

  private async restoreAfterFailedSave(previousConfig: RuntimeConfig): Promise<void> {
    this.config = previousConfig;
    setRuntimeProxyToken(previousConfig.proxy_auth_token ?? null);
    try {
      await this.initUsageStore();
      this.rebuildRotators();
      await this.reconcileStores();
    } catch (rollbackError) {
      // 原始保存错误仍是调用方需要处理的主错误；回滚异常只记录，避免覆盖根因。
      console.error('[config] 保存失败后的内存回滚不完整:', rollbackError);
    }
  }

  private async recoverAfterFailedMutation(previousConfig: RuntimeConfig, error: unknown): Promise<void> {
    if (error instanceof ConfigConflictError) {
      try {
        // CAS 失败说明别的 Worker 已提交新配置；直接加载权威版本，不能保留相同 revision 的本地分叉。
        await this.reloadUnlocked();
        return;
      } catch (reloadError) {
        console.error('[config] 配置冲突后的权威版本重载失败:', reloadError);
      }
    }
    await this.restoreAfterFailedSave(previousConfig);
  }
}

function capabilityLabel(capability: ProviderCapability): string {
  switch (capability) {
    case 'messages': return 'Anthropic Messages';
    case 'count_tokens': return 'count_tokens';
    case 'chat_completions': return 'OpenAI Chat Completions';
    case 'responses': return 'OpenAI Responses';
    case 'models': return '模型列表';
  }
}

interface ResolvedApiKeyCache {
  configuredRef: ApiKeyEntry[] | null;
  sourceSignature: string;
  keys: ApiKeyEntry[];
}

const RESOLVED_API_KEYS = Symbol('resolvedApiKeys');
type RuntimeProviderConfig = ProviderConfig & { [RESOLVED_API_KEYS]?: ResolvedApiKeyCache };

/**
 * 合并文件 Key 与环境变量 Key，但把结果缓存到不可枚举 Symbol 上。
 * 过去把环境变量值写回 provider.api_key，后续保存配置时会把秘密落进配置快照；
 * 运行时缓存既保持 Rotator 引用稳定，也确保序列化永远看不到环境变量值。
 */
function resolveApiKeys(provider: ProviderConfig): ApiKeyEntry[] {
  const runtimeProvider = provider as RuntimeProviderConfig;
  const configured = Array.isArray(provider.api_key) ? provider.api_key : null;
  const envEntries = (provider.api_key_env || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .flatMap((name) => {
      const key = process.env[name]?.trim();
      return key ? [{ key, idBase: `env:${name}` }] : [];
    });
  const sourceSignature = `${typeof provider.api_key === 'string' ? provider.api_key : ''}\0${envEntries.map((entry) => `${entry.idBase}=${entry.key}`).join('\0')}`;
  const cached = runtimeProvider[RESOLVED_API_KEYS];
  if (cached && cached.configuredRef === configured && cached.sourceSignature === sourceSignature) {
    return cached.keys;
  }

  const keys: ApiKeyEntry[] = configured ? [...configured] : [];
  const runtimeValues: Array<{ key: string; idBase?: string }> = [
    ...(typeof provider.api_key === 'string'
      ? provider.api_key.split(',').map((key) => key.trim()).filter(Boolean).map((key) => ({ key }))
      : []),
    ...envEntries,
  ];
  for (const runtimeKey of runtimeValues) {
    if (keys.some((entry) => entry.key === runtimeKey.key)) continue;
    const prior = cached?.keys.find((entry) => entry.key === runtimeKey.key);
    const id = runtimeKey.idBase ? uniqueRuntimeKeyId(runtimeKey.idBase, keys) : undefined;
    keys.push(prior || createRuntimeKey(runtimeKey.key, id));
  }
  Object.defineProperty(runtimeProvider, RESOLVED_API_KEYS, {
    value: { configuredRef: configured, sourceSignature, keys },
    configurable: true,
    writable: true,
  });
  return keys;
}

function ensureConfiguredApiKeys(provider: ProviderConfig): ApiKeyEntry[] {
  if (!Array.isArray(provider.api_key)) provider.api_key = [];
  return provider.api_key;
}

function invalidateResolvedApiKeys(provider: ProviderConfig): void {
  delete (provider as RuntimeProviderConfig)[RESOLVED_API_KEYS];
}

function createRuntimeKey(key: string, id = nanoid()): ApiKeyEntry {
  return {
    id,
    key,
    enabled: true,
    error_count: 0,
    disabled_at: null,
    last_error_at: null,
    last_error_message: null,
    auto_disabled_at: null,
  };
}

function uniqueRuntimeKeyId(base: string, keys: ApiKeyEntry[]): string {
  let candidate = base;
  let suffix = 2;
  while (keys.some((entry) => entry.id === candidate)) {
    candidate = `${base}:${suffix}`;
    suffix++;
  }
  return candidate;
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
 * 检测配置快照是否包含缺 id 的 api_key 项；用于决定 reload 后是否要立刻回写干净版本。
 * normalize 会现场补 id，不能用 normalize 后的结果判断。
 */
function detectMissingIds(raw: RuntimeConfig): boolean {
  if (Array.isArray(raw?.models)) {
    for (const route of raw.models) {
      if (!route || typeof route.route_id !== 'string' || route.route_id.trim() === '') return true;
    }
  }
  if (!Array.isArray(raw?.providers)) return false;
  for (const p of raw.providers) {
    if (!Array.isArray(p?.api_key)) continue;
    for (const entry of p.api_key as Array<{ id?: unknown }>) {
      if (!entry || typeof entry.id !== 'string' || entry.id.trim() === '') return true;
    }
  }
  return false;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
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
