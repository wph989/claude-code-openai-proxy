export interface HttpRequestMeasurement {
  method: string;
  route: string;
  statusCode: number;
  durationSeconds: number;
  ttfbSeconds: number;
}

export interface MetricsSink {
  recordUpstreamError(providerType: string, category: string): void;
  recordUpstreamRetry(providerType: string, category: string): void;
  recordTokens(providerType: string, direction: 'input' | 'output', count: number): void;
}

export const NOOP_METRICS: MetricsSink = {
  recordUpstreamError: () => undefined,
  recordUpstreamRetry: () => undefined,
  recordTokens: () => undefined,
};

interface HistogramSeries {
  labels: Record<string, string>;
  count: number;
  sum: number;
  buckets: number[];
}

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/**
 * 进程内 Prometheus 指标注册表。标签只允许路由模板、状态类别和显式 Provider 类型，
 * 禁止放入请求 ID、模型名、URL 查询、Key 或正文，避免秘密泄露和高基数膨胀。
 */
export class MetricsRegistry implements MetricsSink {
  private activeRequests = 0;
  private readonly httpRequests = new Map<string, { labels: Record<string, string>; value: number }>();
  private readonly durations = new Map<string, HistogramSeries>();
  private readonly ttfb = new Map<string, HistogramSeries>();
  private readonly upstreamErrors = new Map<string, { labels: Record<string, string>; value: number }>();
  private readonly upstreamRetries = new Map<string, { labels: Record<string, string>; value: number }>();
  private readonly tokens = new Map<string, { labels: Record<string, string>; value: number }>();

  requestStarted(): void {
    this.activeRequests += 1;
  }

  requestFinished(measurement: HttpRequestMeasurement): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const labels = {
      method: normalizeLabel(measurement.method.toUpperCase()),
      route: normalizeRoute(measurement.route),
      status_class: `${Math.floor(measurement.statusCode / 100)}xx`,
    };
    increment(this.httpRequests, labels);
    observe(this.durations, labels, measurement.durationSeconds);
    observe(this.ttfb, labels, measurement.ttfbSeconds);
  }

  recordUpstreamError(providerType: string, category: string): void {
    increment(this.upstreamErrors, {
      provider_type: normalizeProviderType(providerType),
      category: normalizeLabel(category),
    });
  }

  recordUpstreamRetry(providerType: string, category: string): void {
    increment(this.upstreamRetries, {
      provider_type: normalizeProviderType(providerType),
      category: normalizeLabel(category),
    });
  }

  recordTokens(providerType: string, direction: 'input' | 'output', count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    increment(this.tokens, {
      provider_type: normalizeProviderType(providerType),
      direction,
    }, Math.trunc(count));
  }

  snapshot(): { activeRequests: number; requestsTotal: number; upstreamErrorsTotal: number; retriesTotal: number } {
    return {
      activeRequests: this.activeRequests,
      requestsTotal: sumSeries(this.httpRequests),
      upstreamErrorsTotal: sumSeries(this.upstreamErrors),
      retriesTotal: sumSeries(this.upstreamRetries),
    };
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    appendMetricHeader(lines, 'ccop_http_requests_total', '代理收到的 HTTP 请求总数', 'counter');
    appendCounter(lines, 'ccop_http_requests_total', this.httpRequests);
    appendMetricHeader(lines, 'ccop_http_requests_active', '当前正在处理的 HTTP 请求数', 'gauge');
    lines.push(`ccop_http_requests_active ${this.activeRequests}`);
    appendHistogram(lines, 'ccop_http_request_duration_seconds', 'HTTP 请求总耗时（秒）', this.durations);
    appendHistogram(lines, 'ccop_http_request_ttfb_seconds', 'HTTP 首字节耗时（秒）', this.ttfb);
    appendMetricHeader(lines, 'ccop_upstream_errors_total', '上游错误分类计数', 'counter');
    appendCounter(lines, 'ccop_upstream_errors_total', this.upstreamErrors);
    appendMetricHeader(lines, 'ccop_upstream_retries_total', '上游重试计数', 'counter');
    appendCounter(lines, 'ccop_upstream_retries_total', this.upstreamRetries);
    appendMetricHeader(lines, 'ccop_tokens_total', '代理处理的 Token 数', 'counter');
    appendCounter(lines, 'ccop_tokens_total', this.tokens);
    return `${lines.join('\n')}\n`;
  }
}

function increment(
  target: Map<string, { labels: Record<string, string>; value: number }>,
  labels: Record<string, string>,
  amount = 1,
): void {
  const key = labelsKey(labels);
  const existing = target.get(key);
  if (existing) existing.value += amount;
  else target.set(key, { labels, value: amount });
}

function observe(target: Map<string, HistogramSeries>, labels: Record<string, string>, value: number): void {
  const safeValue = Number.isFinite(value) && value >= 0 ? value : 0;
  const key = labelsKey(labels);
  let series = target.get(key);
  if (!series) {
    series = { labels, count: 0, sum: 0, buckets: LATENCY_BUCKETS.map(() => 0) };
    target.set(key, series);
  }
  series.count += 1;
  series.sum += safeValue;
  LATENCY_BUCKETS.forEach((bucket, index) => {
    if (safeValue <= bucket) series!.buckets[index] += 1;
  });
}

function appendMetricHeader(lines: string[], name: string, help: string, type: string): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
}

function appendCounter(
  lines: string[],
  name: string,
  series: Map<string, { labels: Record<string, string>; value: number }>,
): void {
  for (const item of sortedSeries(series)) {
    lines.push(`${name}${renderLabels(item.labels)} ${item.value}`);
  }
}

function appendHistogram(
  lines: string[],
  name: string,
  help: string,
  series: Map<string, HistogramSeries>,
): void {
  appendMetricHeader(lines, name, help, 'histogram');
  for (const item of sortedSeries(series)) {
    LATENCY_BUCKETS.forEach((bucket, index) => {
      lines.push(`${name}_bucket${renderLabels({ ...item.labels, le: String(bucket) })} ${item.buckets[index]}`);
    });
    lines.push(`${name}_bucket${renderLabels({ ...item.labels, le: '+Inf' })} ${item.count}`);
    lines.push(`${name}_sum${renderLabels(item.labels)} ${formatNumber(item.sum)}`);
    lines.push(`${name}_count${renderLabels(item.labels)} ${item.count}`);
  }
}

function sortedSeries<T extends { labels: Record<string, string> }>(series: Map<string, T>): T[] {
  return [...series.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

function labelsKey(labels: Record<string, string>): string {
  return Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`).join('\u0000');
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.keys(labels).sort().map((key) => `${key}="${escapeLabel(labels[key])}"`);
  return entries.length > 0 ? `{${entries.join(',')}}` : '';
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function normalizeRoute(route: string): string {
  const raw = String(route || 'unmatched').split('?')[0];
  return normalizeLabel(raw.startsWith('/') ? raw : 'unmatched');
}

function normalizeProviderType(providerType: string): string {
  return providerType === 'anthropic' || providerType === 'openai_compatible' ? providerType : 'unknown';
}

function normalizeLabel(value: string): string {
  return String(value || 'unknown').replace(/[\r\n\t]/g, '_').slice(0, 120);
}

function sumSeries(series: Map<string, { value: number }>): number {
  return [...series.values()].reduce((total, item) => total + item.value, 0);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}
