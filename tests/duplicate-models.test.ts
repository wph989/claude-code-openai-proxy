import { describe, it, expect, vi } from 'vitest';
import { validateRuntimeConfig } from '../src/models.js';
import { ProviderHealthRegistry } from '../src/services/provider-health.js';
import { RuntimeConfigManager } from '../src/services/runtime-config.js';
import type { ConfigRepository } from '../src/services/config/repository.js';

const unusedRepository = {} as ConfigRepository;

describe('允许模型重名', () => {
  it('validateRuntimeConfig 不再拒绝重复的 client_model', () => {
    const config = {
      providers: [
        {
          provider_id: 'p1',
          provider_type: 'openai_compatible' as const,
          base_url: 'https://api1.example.com',
          api_key: 'key1'
        },
        {
          provider_id: 'p2',
          provider_type: 'openai_compatible' as const,
          base_url: 'https://api2.example.com',
          api_key: 'key2'
        }
      ],
      models: [
        { client_model: 'gpt-4', provider_id: 'p1', upstream_model: 'gpt-4-turbo' },
        { client_model: 'gpt-4', provider_id: 'p2', upstream_model: 'gpt-4-turbo' }
      ]
    };

    // 之前会抛出 "models 中存在重复的 client_model: gpt-4"
    // 现在应该通过验证
    expect(() => validateRuntimeConfig(config)).not.toThrow();
  });

  it('resolveModel 从多个同名默认权重路由中确定性选择', () => {
    const config = {
      providers: [
        {
          provider_id: 'provider-a',
          provider_type: 'openai_compatible' as const,
          base_url: 'https://a.example.com',
          api_key: 'key-a'
        },
        {
          provider_id: 'provider-b',
          provider_type: 'openai_compatible' as const,
          base_url: 'https://b.example.com',
          api_key: 'key-b'
        },
        {
          provider_id: 'provider-c',
          provider_type: 'openai_compatible' as const,
          base_url: 'https://c.example.com',
          api_key: 'key-c'
        }
      ],
      models: [
        { client_model: 'shared-model', provider_id: 'provider-a', upstream_model: 'model-a' },
        { client_model: 'shared-model', provider_id: 'provider-b', upstream_model: 'model-b' },
        { client_model: 'shared-model', provider_id: 'provider-c', upstream_model: 'model-c' }
      ]
    };

    const randomValues = [0.1, 0.4, 0.8];
    let randomIndex = 0;
    const manager = new RuntimeConfigManager(unusedRepository, () => randomValues[randomIndex++ % randomValues.length]);
    manager['config'] = config as any;  // 直接设置 config 绕过文件读取

    // 三个默认权重候选分别命中一次，验证选择逻辑而不是依赖概率。
    const counts: Record<string, number> = { 'provider-a': 0, 'provider-b': 0, 'provider-c': 0 };
    const iterations = 3;

    for (let i = 0; i < iterations; i++) {
      const { provider } = manager.resolveModel('shared-model');
      counts[provider.provider_id]++;
    }

    expect(counts).toEqual({ 'provider-a': 1, 'provider-b': 1, 'provider-c': 1 });

    // 验证总次数正确
    expect(counts['provider-a'] + counts['provider-b'] + counts['provider-c']).toBe(iterations);
  });

  it('resolveModel 只返回 enabled 的路由', () => {
    const config = {
      providers: [
        {
          provider_id: 'p1',
          provider_type: 'openai_compatible' as const,
          base_url: 'https://p1.example.com',
          api_key: 'key1'
        },
        {
          provider_id: 'p2',
          provider_type: 'openai_compatible' as const,
          base_url: 'https://p2.example.com',
          api_key: 'key2'
        }
      ],
      models: [
        { client_model: 'test-model', provider_id: 'p1', upstream_model: 'm1', enabled: false },
        { client_model: 'test-model', provider_id: 'p2', upstream_model: 'm2', enabled: true }
      ]
    };

    const manager = new RuntimeConfigManager(unusedRepository);
    manager['config'] = config as any;

    // 只有 p2 的路由 enabled，应该始终选中 p2
    for (let i = 0; i < 10; i++) {
      const { provider } = manager.resolveModel('test-model');
      expect(provider.provider_id).toBe('p2');
    }
  });

  it('resolveModel 在所有同名路由都被禁用时抛出错误', () => {
    const config = {
      providers: [
        {
          provider_id: 'p1',
          provider_type: 'openai_compatible' as const,
          base_url: 'https://p1.example.com',
          api_key: 'key1'
        }
      ],
      models: [
        { client_model: 'disabled-model', provider_id: 'p1', upstream_model: 'm1', enabled: false }
      ]
    };

    const manager = new RuntimeConfigManager(unusedRepository);
    manager['config'] = config as any;

    expect(() => manager.resolveModel('disabled-model')).toThrow('未找到可用的模型映射：disabled-model');
  });

  it('随机选择前排除停用 Provider，始终回退到健康候选', () => {
    const random = vi.fn(() => 0);
    const manager = new RuntimeConfigManager(unusedRepository, random);
    manager['config'] = {
      providers: [
        {
          provider_id: 'disabled-provider',
          provider_type: 'openai_compatible',
          base_url: 'https://disabled.example.com',
          api_key: 'disabled-key',
          enabled: false,
        },
        {
          provider_id: 'healthy-provider',
          provider_type: 'openai_compatible',
          base_url: 'https://healthy.example.com',
          api_key: 'healthy-key',
          enabled: true,
        },
      ],
      models: [
        { client_model: 'shared', provider_id: 'disabled-provider', upstream_model: 'bad' },
        { client_model: 'shared', provider_id: 'healthy-provider', upstream_model: 'good' },
      ],
      default_client_model: 'shared',
    };

    const resolved = manager.resolveModel('shared');
    expect(resolved.provider.provider_id).toBe('healthy-provider');
    // 单一健康候选不需要消费随机源，测试也不会因概率偶发失败。
    expect(random).not.toHaveBeenCalled();
  });

  it('同名路由均无启用 Key 时返回稳定错误', () => {
    const manager = new RuntimeConfigManager(unusedRepository, () => Number.NaN);
    manager['config'] = {
      providers: [{
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com',
        api_key: [{
          id: 'DISABLED01',
          key: 'disabled-key',
          enabled: false,
          error_count: 0,
          disabled_at: null,
          last_error_at: null,
          last_error_message: null,
          auto_disabled_at: null,
        }],
        enabled: true,
      }],
      models: [{ client_model: 'shared', provider_id: 'p1', upstream_model: 'u' }],
      default_client_model: 'shared',
    };

    expect(() => manager.resolveModel('shared')).toThrow('模型 shared 没有启用且具备可用 Key 的供应商。');
  });

  it('按请求端点能力筛选同名路由，不会先选中不兼容 Provider', () => {
    const manager = new RuntimeConfigManager(unusedRepository, () => 0);
    manager['config'] = {
      providers: [
        {
          provider_id: 'anthropic-only',
          provider_type: 'anthropic',
          base_url: 'https://anthropic.example.com',
          api_key: 'anthropic-key',
          enabled: true,
        },
        {
          provider_id: 'responses-provider',
          provider_type: 'openai_compatible',
          base_url: 'https://openai.example.com/v1',
          capabilities: { responses: true },
          api_key: 'openai-key',
          enabled: true,
        },
      ],
      models: [
        { client_model: 'shared', provider_id: 'anthropic-only', upstream_model: 'a' },
        { client_model: 'shared', provider_id: 'responses-provider', upstream_model: 'b' },
      ],
      default_client_model: 'shared',
    };

    expect(manager.resolveModel('shared', 'chat_completions').provider.provider_id).toBe('responses-provider');
    expect(manager.resolveModel('shared', 'responses').provider.provider_id).toBe('responses-provider');
    manager['config'].providers[1].capabilities = { responses: false };
    expect(() => manager.resolveModel('shared', 'responses')).toThrow('没有启用支持 OpenAI Responses');
  });

  it('优先级高于权重，并在高优先级 Provider 熔断时故障转移', () => {
    const manager = new RuntimeConfigManager(unusedRepository, () => 0.99);
    const health = new ProviderHealthRegistry();
    manager.setProviderHealth(health);
    manager['config'] = {
      providers: [
        providerConfig('primary', 'primary-key'),
        providerConfig('backup', 'backup-key'),
      ],
      models: [
        { client_model: 'shared', provider_id: 'primary', upstream_model: 'm1', priority: 0, weight: 1 },
        { client_model: 'shared', provider_id: 'backup', upstream_model: 'm2', priority: 10, weight: 1000 },
      ],
      default_client_model: 'shared',
    };

    expect(manager.resolveModel('shared').provider.provider_id).toBe('primary');
    health.configure('primary', { failure_threshold: 1, recovery_seconds: 30 });
    const lease = health.acquire('primary')!;
    health.recordFailure('primary', 'network', lease);

    expect(manager.resolveModel('shared').provider.provider_id).toBe('backup');
  });

  it('只有全部启用候选都熔断时才返回熔断错误', () => {
    const manager = new RuntimeConfigManager(unusedRepository, () => 0);
    const health = new ProviderHealthRegistry();
    manager.setProviderHealth(health);
    manager['config'] = {
      providers: [
        providerConfig('blocked', 'blocked-key'),
        providerConfig('no-key', null),
      ],
      models: [
        { client_model: 'shared', provider_id: 'blocked', upstream_model: 'm1' },
        { client_model: 'shared', provider_id: 'no-key', upstream_model: 'm2' },
      ],
      default_client_model: 'shared',
    };
    health.configure('blocked', { failure_threshold: 1, recovery_seconds: 30 });
    const lease = health.acquire('blocked')!;
    health.recordFailure('blocked', 'network', lease);

    expect(() => manager.resolveModel('shared')).toThrow('模型 shared 没有启用且具备可用 Key 的供应商。');

    manager['config'].providers[1].api_key = 'second-key';
    health.configure('no-key', { failure_threshold: 1, recovery_seconds: 30 });
    const secondLease = health.acquire('no-key')!;
    health.recordFailure('no-key', 'server', secondLease);
    expect(() => manager.resolveModel('shared')).toThrow('模型 shared 的供应商均处于熔断冷却中，请稍后重试。');
  });
});

function providerConfig(providerId: string, apiKey: string | null) {
  return {
    provider_id: providerId,
    provider_type: 'openai_compatible' as const,
    base_url: `https://${providerId}.example.com`,
    api_key: apiKey,
    enabled: true,
  };
}
