import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { settings } from '../config.js';
import { setRuntimeProxyToken } from '../auth.js';
import {
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
 */
export class RuntimeConfigManager {
  private configPath: string;
  private config: RuntimeConfig = { providers: [], models: [], default_client_model: null };

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
    // 同步代理 Token 到运行时
    setRuntimeProxyToken(this.config.proxy_auth_token ?? null);
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
    // 同步代理 Token 到运行时
    setRuntimeProxyToken(this.config.proxy_auth_token ?? null);
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

  resolveModel(clientModel: string): { route: ResolvedRoute; provider: ResolvedProvider; enabledProviderIds: string[] } {
    const normalizedModel = String(clientModel || '').trim();
    const route = this.config.models.find((item) => item.client_model === normalizedModel);
    if (!route || route.enabled === false) {
      throw new Error(`未找到可用的模型映射：${normalizedModel}`);
    }

    const provider = this.config.providers.find((item) => item.provider_id === route.provider_id);
    const enabledProviderIds = this.config.providers.filter((item) => item.enabled !== false).map((item) => item.provider_id);

    if (!provider || provider.enabled === false) {
      throw new Error(`未找到可用的供应商：${route.provider_id}。当前启用的供应商：${enabledProviderIds.join(', ') || '无'}`);
    }

    const resolvedProvider: ResolvedProvider = {
      provider_id: provider.provider_id,
      provider_type: provider.provider_type,
      base_url: replaceEnv(provider.base_url),
      api_key: provider.api_key || resolveApiKey(provider),
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

    return { route: resolvedRoute, provider: resolvedProvider, enabledProviderIds };
  }
}

function resolveApiKey(provider: ProviderConfig): string | null {
  const envName = provider.api_key_env?.trim();
  if (!envName) {
    return null;
  }
  return process.env[envName]?.trim() || null;
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
