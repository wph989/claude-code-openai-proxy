import { describe, expect, it } from 'vitest';
import { collectProviderForm, providerFormHtml } from '../src/static/forms/provider-form.js';
import { collectModelForm, modelFormHtml } from '../src/static/forms/model-form.js';
import { parseJsonSafe } from '../src/static/forms/shared.js';

describe('管理端表单模块', () => {
  it('供应商表单只展示掩码并转义配置字段', () => {
    const html = providerFormHtml({
      provider_id: 'p1"><script>alert(1)</script>',
      provider_type: 'openai_compatible',
      base_url: 'https://example.com',
      api_key: [{ key: 'full-secret-key', key_mask: '********cret', enabled: true }],
      headers: {},
    });

    expect(html).toContain('p1&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('********cret');
    expect(html).not.toContain('full-secret-key');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('模型表单转义 Provider 选项和已有模型字段', () => {
    const html = modelFormHtml({
      client_model: '</textarea><img src=x>',
      provider_id: 'safe-provider',
      upstream_model: 'upstream-model',
    }, [
      { provider_id: 'safe-provider' },
      { provider_id: '"><img src=x onerror=alert(1)>' },
    ]);

    expect(html).toContain('&lt;/textarea&gt;&lt;img src=x&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('表单展示并收集熔断、优先级和权重字段', () => {
    const providerHtml = providerFormHtml({
      provider_id: 'p1',
      provider_type: 'openai_compatible',
      base_url: 'https://example.com',
      circuit_breaker: { failure_threshold: 5, recovery_seconds: 45 },
    });
    const modelHtml = modelFormHtml({
      client_model: 'client',
      provider_id: 'p1',
      upstream_model: 'upstream',
      priority: 7,
      weight: 2.5,
    }, [{ provider_id: 'p1' }]);

    expect(providerHtml).toContain('id="mf-circuit_breaker_enabled" type="checkbox" checked');
    expect(providerHtml).toContain('id="mf-circuit_failure_threshold"');
    expect(providerHtml).toContain('value="5"');
    expect(providerHtml).toContain('value="45"');
    expect(modelHtml).toContain('id="mf-priority"');
    expect(modelHtml).toContain('value="7"');
    expect(modelHtml).toContain('id="mf-weight"');
    expect(modelHtml).toContain('value="2.5"');
  });

  it('收集模型策略字段并拒绝越界值', () => {
    withFakeDocument({
      'mf-client_model': input('client'),
      'mf-provider_id': input('p1'),
      'mf-upstream_model': input('upstream'),
      'mf-priority': input('3'),
      'mf-weight': input('4.5'),
      'mf-enabled': input('', true),
      'mf-extra_body': input('{"temperature":0.2}'),
      'mf-description': input('route'),
    }, () => {
      expect(collectModelForm()).toMatchObject({ priority: 3, weight: 4.5, enabled: true });
    });

    withFakeDocument({
      'mf-client_model': input('client'),
      'mf-provider_id': input('p1'),
      'mf-upstream_model': input('upstream'),
      'mf-priority': input('3.5'),
      'mf-weight': input('1'),
    }, () => {
      expect(() => collectModelForm()).toThrow('优先级必须是 0~1000 的整数');
    });
  });

  it('关闭 Provider 熔断时提交显式 null', () => {
    withFakeDocument({
      'mf-provider_id': input('p1'),
      'mf-provider_type': input('openai_compatible'),
      'mf-base_url': input('https://example.com'),
      'mf-api_key_env': input(''),
      'mf-key_rotation_strategy': input('round_robin'),
      'mf-timeout_seconds': input('300'),
      'mf-stream_idle_timeout_seconds': input('120'),
      'mf-enabled': input('', true),
      'mf-auto_disable_on_error': input('', true),
      'mf-auto_recover_minutes': input('0'),
      'mf-circuit_breaker_enabled': input('', false),
      'mf-circuit_failure_threshold': input('3'),
      'mf-circuit_recovery_seconds': input('30'),
      'mfq-max-req': input(''),
      'mfq-max-tok': input(''),
      'mfq-threshold': input(''),
      'mf-headers': input('{}'),
      'mf-description': input('provider'),
    }, () => {
      expect(collectProviderForm().circuit_breaker).toBeNull();
    });
  });

  it('JSON 字段为空时返回默认值，非法 JSON 给出明确错误', () => {
    expect(parseJsonSafe('  ', {})).toEqual({});
    expect(parseJsonSafe('{"top_k":20}', {})).toEqual({ top_k: 20 });
    expect(() => parseJsonSafe('{broken', {})).toThrow('JSON 字段格式不正确');
  });
});

function input(value = '', checked = false) {
  return { value, checked };
}

function withFakeDocument(elements: Record<string, { value: string; checked: boolean }>, run: () => void): void {
  const previous = (globalThis as { document?: unknown }).document;
  const fakeDocument = {
    querySelector(selector: string) {
      return elements[selector.replace(/^#/, '')];
    },
    getElementById(id: string) {
      return elements[id];
    },
  };
  Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true, writable: true });
  try {
    run();
  } finally {
    if (previous === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, 'document', { value: previous, configurable: true, writable: true });
  }
}
