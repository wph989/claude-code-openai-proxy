import { describe, expect, it } from 'vitest';
import { renderPagination, renderTableHead } from '../src/static/components/data-table.js';
import { renderKeyPanelHtml } from '../src/static/views/key-panel.js';
import { renderModelRow, renderProviderRow } from '../src/static/views/resource-rows.js';
import { renderChangePreview, renderSummary } from '../src/static/views/summary-view.js';
import { renderActivityView } from '../src/static/views/activity-view.js';

describe('管理端视图模块', () => {
  it('资源行转义服务端配置字段', () => {
    const provider = renderProviderRow({
      provider_id: '"><script>alert(1)</script>',
      provider_type: 'openai_compatible',
      base_url: 'https://example.com/?q="><img src=x>',
      api_key: [],
      enabled: true,
      circuit_status: { state: 'open', consecutive_failures: 3, open_until: Date.now() + 30_000 },
    }, 0, null, { key_auto_disable: true });
    const model = renderModelRow({
      client_model: '<img src=x>',
      provider_id: 'p1',
      upstream_model: 'upstream',
      priority: 2,
      weight: 4.5,
      enabled: true,
    }, 0);

    expect(provider).not.toContain('<script>alert(1)</script>');
    expect(provider).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(provider).toContain('熔断中');
    expect(model).not.toContain('<img src=x>');
    expect(model).toContain('>2<');
    expect(model).toContain('>4.5<');
  });

  it('Key 面板只渲染掩码并转义诊断信息', () => {
    const html = renderKeyPanelHtml('p1"><img src=x>', [{
      id: 'KEY1',
      key_mask: '********cret',
      key: 'full-secret-key',
      source: 'config',
      enabled: false,
      error_count: 1,
      last_error_message: '<script>bad()</script>',
      disabled_at: null,
    }]);

    expect(html).toContain('********cret');
    expect(html).not.toContain('full-secret-key');
    expect(html).not.toContain('<script>bad()</script>');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
  });

  it('摘要、变更预览和表格组件按传入数据渲染', () => {
    const summaryContainer = { innerHTML: '' };
    renderSummary(summaryContainer, { provider_count: 2, model_count: 3 });
    expect(summaryContainer.innerHTML).toContain('供应商总数');
    expect(summaryContainer.innerHTML).toContain('>2<');

    const previewContainer = { innerHTML: '', textContent: '' };
    renderChangePreview(previewContainer, {
      has_changes: true,
      changes: [{ scope: 'provider', action: 'update', target: '<p1>', fields: ['base_url'] }],
    });
    expect(previewContainer.innerHTML).toContain('&lt;p1&gt;');

    expect(renderTableHead(['provider_id'], { field: 'provider_id', asc: true }, ['ID'])).toContain('▲');
    expect(renderPagination(2, 3, 25)).toContain('第 2/3 页');
  });

  it('活动日志只渲染结构化摘要并转义资源字段', () => {
    const html = renderActivityView([{
      id: 1,
      type: 'request.completed',
      timestamp: '2026-07-18T08:00:00.000Z',
      data: {
        method: 'POST',
        route: '/v1/messages?<script>alert(1)</script>',
        status_code: 200,
        duration_ms: 12,
        ttfb_ms: 4,
      },
    }], { connected: true, filter: 'all' });

    expect(html).toContain('实时连接');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('{"method"');
  });
});
