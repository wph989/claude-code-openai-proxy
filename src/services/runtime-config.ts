import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { settings } from '../config.js';
import { setRuntimeProxyToken } from '../auth.js';
import { ApiKeyRotator, type KeyStateChange } from './api-key-rotator.js';
import {
  KeyRotationStrategy,
  type ApiKeyEntry,
  type ProviderConfig,
  type ResolvedProvider,
  type ResolvedRoute,
  type RuntimeConfig,
  normalizeRuntimeConfig,
  summarizeRuntimeConfig,
  validateRuntimeConfig
} from '../models.js';

/**
 * 运行时配置管理器：
 * - 负责初始化配置文件
 * - 保存配置后立即热生效
 * - 对 provider_id / client_model / 引用关系做强校验
 * - 管理 API Key 状态（错误计数、启用/禁用）并持久化
 */
export class RuntimeConfigManager {
  private configPath: string;
  private config: RuntimeConfig = { providers: [], models: [], default_client_model: null };
  private rotators: Map<string, ApiKeyRotator> = new Map();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persisting: Promise<void> | null = null;

  constructor(configPath = settings.configFile) {
    this.configPath = path.resolve(configPath);
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

  async reload(): Promise<RuntimeConfig> {
    const text = await readFile(this.configPath, 'utf-8');
    const raw = JSON.parse(text) as RuntimeConfig;
    this.config = validateRuntimeConfig(raw);
    setRuntimeProxyToken(this.config.proxy_auth_token ?? null);
    applyGlobalSettings(this.config);
    this.rebuildRotators();
    return this.getConfig();
  }

  async ensureDefaultConfig(): Promise<void> {
    const dir = path.dirname(this.configPath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.configPath, JSON.stringify(buildDefaultRuntimeConfig(), null, 2) + '\n', 'utf-8');
    console.log(`[init] 配置文件已创建: ${this.configPath}`);
  }

  async saveConfig(raw: RuntimeConfig): Promise<RuntimeConfig> {
    const validated = validateRuntimeConfig(raw);
    const dir = path.dirname(this.configPath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.configPath, JSON.stringify(validated, null, 2) + '\n', 'utf-8');
    this.config = validated;
    setRuntimeProxyToken(this.config.proxy_auth_token ?? null);
    applyGlobalSettings(this.config);
    this.rebuildRotators();
    return this.getConfig();
  }

  summary() {
    return summarizeRuntimeConfig(this.config);
  }

  adminView() {
    return {
      config: this.getConfig(),
      summary: this.summary(),
      provider_options: this.config.providers.map((item) => ({
        provider_id: item.provider_id,
        label: `${item.provider_id} (${item.enabled !== false ? '启用' : '停用'})`
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

  resolveModel(clientModel: string): { route: ResolvedRoute; provider: ResolvedProvider; rotator: ApiKeyRotator } {
    const normalizedModel = String(clientModel || '').trim();
    const route = this.config.models.find((item) => item.client_model === normalizedModel);
    if (!route || route.enabled === false) {
      throw new Error(`未找到可用的模型映射：${normalizedModel}`);
    }

    const provider = this.config.providers.find((item) => item.provider_id === route.provider_id);

    if (!provider || provider.enabled === false) {
      const enabledProviderIds = this.config.providers.filter((item) => item.enabled !== false).map((item) => item.provider_id);
      throw new Error(`未找到可用的供应商：${route.provider_id}。当前启用的供应商：${enabledProviderIds.join(', ') || '无'}`);
    }

    const apiKeys = resolveApiKeys(provider);
    const autoDisable = provider.auto_disable_on_error !== false;
    const rotator = this.getOrCreateRotator(provider.provider_id, apiKeys, provider.key_rotation_strategy ?? KeyRotationStrategy.round_robin, autoDisable);

    const resolvedProvider: ResolvedProvider = {
      provider_id: provider.provider_id,
      provider_type: provider.provider_type,
      base_url: replaceEnv(provider.base_url),
      api_keys: apiKeys,
      key_rotation_strategy: provider.key_rotation_strategy ?? KeyRotationStrategy.round_robin,
      auto_disable_on_error: autoDisable,
      timeout_seconds: provider.timeout_seconds || 300,
      stream_idle_timeout_seconds: provider.stream_idle_timeout_seconds || 120,
      enabled: !!provider.enabled,
      headers: normalizeHeaders(provider.headers || {}),
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

  private getOrCreateRotator(providerId: string, keys: ApiKeyEntry[], strategy: KeyRotationStrategy, autoDisable: boolean): ApiKeyRotator {
    const existing = this.rotators.get(providerId);
    if (existing && keysEqual(existing.keys, keys) && existing.strategy === strategy) {
      return existing;
    }
    const rotator = new ApiKeyRotator(keys, strategy, autoDisable);
    rotator.onChange = (key, patch) => this.onKeyStateChange(providerId, key, patch);
    this.rotators.set(providerId, rotator);
    return rotator;
  }

  private rebuildRotators(): void {
    this.rotators.clear();
    for (const provider of this.config.providers) {
      const apiKeys = resolveApiKeys(provider);
      const strategy = provider.key_rotation_strategy ?? KeyRotationStrategy.round_robin;
      const autoDisable = provider.auto_disable_on_error !== false;
      if (apiKeys.length > 0) {
        const rotator = new ApiKeyRotator(apiKeys, strategy, autoDisable);
        rotator.onChange = (key, patch) => this.onKeyStateChange(provider.provider_id, key, patch);
        this.rotators.set(provider.provider_id, rotator);
      }
    }
  }

  private onKeyStateChange(providerId: string, key: string, patch: KeyStateChange): void {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) return;

    const keys = resolveApiKeys(provider);
    const entry = keys.find((k) => k.key === key);
    if (!entry) return;

    Object.assign(entry, patch);
    provider.api_key = keys;

    this.schedulePersist();
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
        const dir = path.dirname(this.configPath);
        await mkdir(dir, { recursive: true });
        const tmpPath = this.configPath + '.tmp';
        await writeFile(tmpPath, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
        await rename(tmpPath, this.configPath);
      } catch (err) {
        console.error('[config] 持久化配置失败:', err);
      } finally {
        this.persisting = null;
      }
    })();
    return this.persisting;
  }

  getKeyStates(providerId: string): ApiKeyEntry[] {
    const rotator = this.rotators.get(providerId);
    if (!rotator) return [];
    return rotator.getKeys();
  }

  async updateKeyState(providerId: string, keyIndex: number, patch: Partial<ApiKeyEntry>): Promise<void> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new Error(`未找到供应商：${providerId}`);

    const keys = resolveApiKeys(provider);
    if (keyIndex < 0 || keyIndex >= keys.length) {
      throw new Error(`无效的 key 索引：${keyIndex}`);
    }

    const entry = keys[keyIndex];
    Object.assign(entry, patch);
    provider.api_key = keys;

    const rotator = this.rotators.get(providerId);
    if (rotator) {
      const rotatorKeys = rotator.getKeys();
      const rotatorEntry = rotatorKeys.find((k) => k.key === entry.key);
      if (rotatorEntry) {
        Object.assign(rotatorEntry, patch);
      }
    }

    await this.persistNow();
  }

  async enableKey(providerId: string, keyIndex: number): Promise<void> {
    const rotator = this.rotators.get(providerId);
    if (!rotator) throw new Error(`未找到供应商的 rotator：${providerId}`);

    const keys = rotator.getKeys();
    if (keyIndex < 0 || keyIndex >= keys.length) {
      throw new Error(`无效的 key 索引：${keyIndex}`);
    }

    rotator.enableKey(keys[keyIndex].key);
    await this.persistNow();
  }

  async disableKey(providerId: string, keyIndex: number): Promise<void> {
    const rotator = this.rotators.get(providerId);
    if (!rotator) throw new Error(`未找到供应商的 rotator：${providerId}`);

    const keys = rotator.getKeys();
    if (keyIndex < 0 || keyIndex >= keys.length) {
      throw new Error(`无效的 key 索引：${keyIndex}`);
    }

    rotator.disableKey(keys[keyIndex].key);
    await this.persistNow();
  }

  async resetKey(providerId: string, keyIndex: number): Promise<void> {
    const rotator = this.rotators.get(providerId);
    if (!rotator) throw new Error(`未找到供应商的 rotator：${providerId}`);

    const keys = rotator.getKeys();
    if (keyIndex < 0 || keyIndex >= keys.length) {
      throw new Error(`无效的 key 索引：${keyIndex}`);
    }

    rotator.resetErrorCount(keys[keyIndex].key);
    await this.persistNow();
  }

  async addKey(providerId: string, keyValue: string): Promise<ApiKeyEntry> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new Error(`未找到供应商：${providerId}`);

    const trimmed = keyValue.trim();
    if (!trimmed) throw new Error('Key 值不能为空');

    const keys = resolveApiKeys(provider);
    if (keys.some((k) => k.key === trimmed)) {
      throw new Error('该 Key 已存在');
    }

    const newKey: ApiKeyEntry = {
      key: trimmed,
      enabled: true,
      error_count: 0,
      disabled_at: null,
      last_error_at: null,
      last_error_message: null,
      auto_disabled_at: null
    };

    keys.push(newKey);
    provider.api_key = keys;

    this.rebuildRotators();
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
      entry.error_count = 0;
      entry.enabled = true;
      entry.disabled_at = null;
      entry.auto_disabled_at = null;
      entry.last_error_at = null;
      entry.last_error_message = null;
      count++;
    }
    provider.api_key = keys;
    this.rebuildRotators();
    await this.persistNow();
    return count;
  }

  async addKeys(providerId: string, keyValues: string[]): Promise<{ added: string[]; skipped: string[] }> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new Error(`未找到供应商：${providerId}`);

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
      provider.api_key = keys;
      this.rebuildRotators();
      await this.persistNow();
    }

    return { added, skipped };
  }

  async deleteKey(providerId: string, keyIndex: number): Promise<void> {
    const provider = this.config.providers.find((p) => p.provider_id === providerId);
    if (!provider) throw new Error(`未找到供应商：${providerId}`);

    const keys = resolveApiKeys(provider);
    if (keyIndex < 0 || keyIndex >= keys.length) {
      throw new Error(`无效的 key 索引：${keyIndex}`);
    }

    keys.splice(keyIndex, 1);
    provider.api_key = keys;

    this.rebuildRotators();
    await this.persistNow();
  }
}

function resolveApiKeys(provider: ProviderConfig): ApiKeyEntry[] {
  const keys: ApiKeyEntry[] = [];

  if (provider.api_key) {
    if (typeof provider.api_key === 'string') {
      for (const key of provider.api_key.split(',')) {
        const trimmed = key.trim();
        if (trimmed) {
          keys.push({
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
    } else if (Array.isArray(provider.api_key)) {
      keys.push(...provider.api_key);
    }
  }

  if (provider.api_key_env) {
    for (const envName of provider.api_key_env.split(',')) {
      const trimmed = envName.trim();
      if (trimmed) {
        const val = process.env[trimmed]?.trim();
        if (val) {
          keys.push({
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

  const seen = new Set<string>();
  const unique: ApiKeyEntry[] = [];
  for (const entry of keys) {
    if (!seen.has(entry.key)) {
      seen.add(entry.key);
      unique.push(entry);
    }
  }
  return unique;
}

function keysEqual(a: ApiKeyEntry[], b: ApiKeyEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => entry.key === b[i].key && entry.enabled === b[i].enabled);
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

function applyGlobalSettings(config: RuntimeConfig): void {
  if (config.key_max_errors != null && config.key_max_errors > 0) {
    settings.keyMaxErrors = config.key_max_errors;
  }
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
    proxy_auth_token: null
  });
}
