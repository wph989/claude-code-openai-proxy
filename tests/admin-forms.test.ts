import { describe, expect, it } from 'vitest';
import { providerFormHtml } from '../src/static/forms/provider-form.js';
import { modelFormHtml } from '../src/static/forms/model-form.js';
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

  it('JSON 字段为空时返回默认值，非法 JSON 给出明确错误', () => {
    expect(parseJsonSafe('  ', {})).toEqual({});
    expect(parseJsonSafe('{"top_k":20}', {})).toEqual({ top_k: 20 });
    expect(() => parseJsonSafe('{broken', {})).toThrow('JSON 字段格式不正确');
  });
});
