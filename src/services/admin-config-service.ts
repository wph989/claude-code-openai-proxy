import { RuntimeConfigError } from '../errors.js';
import type { AntiBanConfig, ModelRouteConfig } from '../types/runtime-config.js';
import { nanoid } from '../utils/nanoid.js';
import type { AdminRuntimeConfigView } from './admin-config.js';
import type { RuntimeConfigManager } from './runtime-config.js';

export interface GlobalSettingsPatch {
  default_client_model?: string | null;
  key_max_errors?: number | null;
  anti_ban?: AntiBanConfig;
}

/**
 * 管理端资源级写服务。内部仍通过 RuntimeConfigManager 兼容门面保存，
 * 但路由不再需要读取、拼装整份配置，后续可逐个资源迁移到独立仓储。
 */
export class AdminConfigService {
  constructor(private readonly manager: RuntimeConfigManager) {}

  async patchSettings(patch: GlobalSettingsPatch, expectedRevision: number): Promise<void> {
    const config = this.currentConfig();
    if ('default_client_model' in patch) config.default_client_model = patch.default_client_model ?? null;
    if ('key_max_errors' in patch) config.key_max_errors = patch.key_max_errors ?? null;
    if ('anti_ban' in patch) config.anti_ban = patch.anti_ban;
    await this.manager.saveAdminConfig(config, expectedRevision);
  }

  async createProvider(input: unknown, expectedRevision: number): Promise<void> {
    const provider = requireRecord(input, '供应商');
    const providerId = requireString(provider.provider_id, 'provider_id');
    const config = this.currentConfig();
    if (config.providers.some((item) => item.provider_id === providerId)) {
      throw new RuntimeConfigError(`供应商已存在：${providerId}`);
    }
    // Key 必须走独立写接口，防止资源响应意外回显新秘密。
    config.providers.push({ ...provider, provider_id: providerId, api_key: [] } as never);
    await this.manager.saveAdminConfig(config, expectedRevision);
  }

  async patchProvider(providerId: string, input: unknown, expectedRevision: number): Promise<void> {
    const patch = requireRecord(input, '供应商');
    const config = this.currentConfig();
    const index = config.providers.findIndex((item) => item.provider_id === providerId);
    if (index < 0) throw new RuntimeConfigError(`未找到供应商：${providerId}`);
    const current = config.providers[index];
    const { provider_id: _ignoredId, api_key: _ignoredKeys, ...fields } = patch;
    config.providers[index] = {
      ...current,
      ...fields,
      provider_id: providerId,
      api_key: current.api_key,
    } as typeof current;
    await this.manager.saveAdminConfig(config, expectedRevision);
  }

  async deleteProvider(providerId: string, expectedRevision: number): Promise<void> {
    const config = this.currentConfig();
    const index = config.providers.findIndex((item) => item.provider_id === providerId);
    if (index < 0) throw new RuntimeConfigError(`未找到供应商：${providerId}`);
    const referencedRoutes = config.models.filter((route) => route.provider_id === providerId);
    if (referencedRoutes.length > 0) {
      throw new RuntimeConfigError(`供应商 ${providerId} 仍被 ${referencedRoutes.length} 条模型路由引用。`);
    }
    config.providers.splice(index, 1);
    await this.manager.saveAdminConfig(config, expectedRevision);
  }

  async createRoute(input: unknown, expectedRevision: number): Promise<string> {
    const route = requireRecord(input, '模型路由');
    const config = this.currentConfig();
    const routeId = nanoid();
    config.models.push({ ...route, route_id: routeId } as unknown as ModelRouteConfig);
    await this.manager.saveAdminConfig(config, expectedRevision);
    return routeId;
  }

  async patchRoute(routeId: string, input: unknown, expectedRevision: number): Promise<void> {
    const patch = requireRecord(input, '模型路由');
    const config = this.currentConfig();
    const index = config.models.findIndex((route) => route.route_id === routeId);
    if (index < 0) throw new RuntimeConfigError(`未找到模型路由：${routeId}`);
    const { route_id: _ignoredId, ...fields } = patch;
    config.models[index] = { ...config.models[index], ...fields, route_id: routeId };
    await this.manager.saveAdminConfig(config, expectedRevision);
  }

  async deleteRoute(routeId: string, expectedRevision: number): Promise<void> {
    const config = this.currentConfig();
    const index = config.models.findIndex((route) => route.route_id === routeId);
    if (index < 0) throw new RuntimeConfigError(`未找到模型路由：${routeId}`);
    const [removed] = config.models.splice(index, 1);
    if (config.default_client_model === removed.client_model
      && !config.models.some((route) => route.client_model === removed.client_model)) {
      config.default_client_model = null;
    }
    await this.manager.saveAdminConfig(config, expectedRevision);
  }

  private currentConfig(): AdminRuntimeConfigView {
    return structuredClone(this.manager.adminView().config);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeConfigError(`${label}配置格式无效。`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new RuntimeConfigError(`${field} 不能为空。`);
  return result;
}
