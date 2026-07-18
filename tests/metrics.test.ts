import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../src/services/metrics.js';

describe('MetricsRegistry', () => {
  it('输出 Prometheus counter、gauge 和 histogram，且标签不包含查询或秘密', () => {
    const metrics = new MetricsRegistry();
    metrics.requestStarted();
    metrics.requestFinished({
      method: 'post',
      route: '/v1/messages?token=must-not-leak',
      statusCode: 200,
      durationSeconds: 0.12,
      ttfbSeconds: 0.03,
    });
    metrics.recordUpstreamError('openai_compatible', 'rate_limit');
    metrics.recordUpstreamRetry('openai_compatible', 'rate_limit');
    metrics.recordTokens('openai_compatible', 'input', 17);

    const output = metrics.renderPrometheus();
    expect(output).toContain('ccop_http_requests_total{method="POST",route="/v1/messages",status_class="2xx"} 1');
    expect(output).toContain('ccop_http_request_duration_seconds_bucket');
    expect(output).toContain('ccop_upstream_retries_total{category="rate_limit",provider_type="openai_compatible"} 1');
    expect(output).toContain('ccop_tokens_total{direction="input",provider_type="openai_compatible"} 17');
    expect(output).not.toContain('must-not-leak');
    expect(metrics.snapshot()).toEqual({
      activeRequests: 0,
      requestsTotal: 1,
      upstreamErrorsTotal: 1,
      retriesTotal: 1,
    });
  });

  it('未知 Provider 类型归一化，非法计数不会污染指标', () => {
    const metrics = new MetricsRegistry();
    metrics.recordUpstreamError('secret-provider\nkey=value', 'network\nsecret');
    metrics.recordTokens('anthropic', 'output', Number.NaN);

    const output = metrics.renderPrometheus();
    expect(output).toContain('provider_type="unknown"');
    expect(output).toContain('category="network_secret"');
    expect(output).not.toContain('key=value');
    expect(output).not.toContain('ccop_tokens_total{');
  });
});
