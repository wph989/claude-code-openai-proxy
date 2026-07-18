import type {
  RuntimeConfigObserver,
  RuntimeKeyStateEvent,
  RuntimeKeyUsageEvent,
} from './runtime-config.js';

export type AdminEventType =
  | 'config.changed'
  | 'key.changed'
  | 'quota.changed'
  | 'request.completed'
  | 'provider.tested';

export type AdminEventData = Record<string, string | number | boolean | null>;

export interface AdminEvent {
  id: number;
  type: AdminEventType;
  timestamp: string;
  data: AdminEventData;
}

type AdminEventListener = (event: AdminEvent) => void;

export class AdminEventStream implements RuntimeConfigObserver {
  private readonly history: AdminEvent[] = [];
  private readonly listeners = new Set<AdminEventListener>();
  private sequence = 0;

  constructor(
    private readonly historyLimit = 100,
    private readonly now: () => Date = () => new Date(),
  ) {}

  subscribe(listener: AdminEventListener, afterId = 0): () => void {
    for (const event of this.history) {
      if (event.id > afterId) listener(event);
    }
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  configChanged(params: {
    scope: 'config' | 'settings' | 'provider' | 'route' | 'proxy_token';
    action: string;
    revision: number;
    providerId?: string;
    routeId?: string;
  }): void {
    this.emit('config.changed', {
      scope: params.scope,
      action: cleanText(params.action),
      revision: params.revision,
      provider_id: cleanOptionalText(params.providerId),
      route_id: cleanOptionalText(params.routeId),
    });
  }

  keyChanged(params: {
    providerId: string;
    action: string;
    keyId?: string;
    count?: number;
    revision?: number;
  }): void {
    this.emit('key.changed', {
      provider_id: cleanText(params.providerId),
      action: cleanText(params.action),
      key_id: cleanOptionalText(params.keyId),
      count: toNonNegativeInteger(params.count),
      revision: toPositiveInteger(params.revision),
    });
  }

  providerTested(params: {
    providerId: string;
    providerType: string;
    ok: boolean;
    statusCode: number | null;
    latencyMs: number;
    category: string;
  }): void {
    this.emit('provider.tested', {
      provider_id: cleanText(params.providerId),
      provider_type: cleanText(params.providerType),
      ok: params.ok,
      status_code: params.statusCode,
      latency_ms: toNonNegativeInteger(params.latencyMs),
      category: cleanText(params.category),
    });
  }

  requestCompleted(params: {
    method: string;
    route: string;
    statusCode: number;
    durationMs: number;
    ttfbMs: number;
  }): void {
    if (!shouldPublishRequest(params.method, params.route)) return;
    this.emit('request.completed', {
      method: cleanText(params.method, 16),
      route: cleanText(params.route, 160),
      status_code: params.statusCode,
      duration_ms: toNonNegativeInteger(params.durationMs),
      ttfb_ms: toNonNegativeInteger(params.ttfbMs),
    });
  }

  onKeyStateChanged(event: RuntimeKeyStateEvent): void {
    this.emit('key.changed', {
      provider_id: cleanText(event.providerId),
      key_id: cleanText(event.keyId),
      action: 'runtime_state',
      enabled: event.enabled,
      error_count: event.errorCount,
      auto_disabled: event.autoDisabled,
      revision: event.revision,
    });
  }

  onKeyUsageChanged(event: RuntimeKeyUsageEvent): void {
    this.emit('quota.changed', {
      provider_id: cleanText(event.providerId),
      key_id: cleanText(event.keyId),
      requests_used: event.requestsUsed,
      tokens_used: event.tokensUsed,
      usage_ratio: Number.isFinite(event.ratio) ? Number(event.ratio.toFixed(4)) : 0,
      blocked: event.blocked,
      revision: event.revision,
    });
  }

  private emit(type: AdminEventType, data: AdminEventData): void {
    const event: AdminEvent = {
      id: ++this.sequence,
      type,
      timestamp: this.now().toISOString(),
      data,
    };
    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.shift();
    for (const listener of this.listeners) listener(event);
  }
}

export function formatAdminEventSse(event: AdminEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

function shouldPublishRequest(method: string, route: string): boolean {
  if (route.startsWith('/v1/')) return true;
  if (!route.startsWith('/api/') || method.toUpperCase() === 'GET') return false;
  return route !== '/api/config/preview' && route !== '/api/admin/events';
}

function cleanOptionalText(value: string | undefined): string | null {
  return value == null ? null : cleanText(value);
}

function cleanText(value: string, maxLength = 120): string {
  return String(value || '').replace(/[\r\n\0]/g, ' ').slice(0, maxLength);
}

function toNonNegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : 0;
}

function toPositiveInteger(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}
