import { describe, it, expect } from 'vitest';
import { validateRuntimeConfig } from '../src/models.js';
import { RuntimeConfigManager } from '../src/services/runtime-config.js';

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

  it('resolveModel 从多个同名路由中随机选择', () => {
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

    const manager = new RuntimeConfigManager();
    manager['config'] = config as any;  // 直接设置 config 绕过文件读取

    // 调用 50 次，统计每个 provider 被选中的次数
    const counts: Record<string, number> = { 'provider-a': 0, 'provider-b': 0, 'provider-c': 0 };
    const iterations = 50;

    for (let i = 0; i < iterations; i++) {
      const { provider } = manager.resolveModel('shared-model');
      counts[provider.provider_id]++;
    }

    // 验证所有 3 个 provider 都被选中过（随机分布）
    expect(counts['provider-a']).toBeGreaterThan(0);
    expect(counts['provider-b']).toBeGreaterThan(0);
    expect(counts['provider-c']).toBeGreaterThan(0);

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

    const manager = new RuntimeConfigManager();
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

    const manager = new RuntimeConfigManager();
    manager['config'] = config as any;

    expect(() => manager.resolveModel('disabled-model')).toThrow('未找到可用的模型映射：disabled-model');
  });
});
