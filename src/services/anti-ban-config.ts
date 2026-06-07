import type {
  AntiBanConfig,
  AntiBanMode,
  KeySelectionMode,
  StickyOnCooldown,
  RetryConfig,
  SelectorConfig,
  HealthConfig,
  QuotaPersistConfig
} from '../models.js';

export interface ResolvedAntiBan {
  mode: AntiBanMode;
  max_concurrent: number;
  min_interval_ms: number;
  rate_limit_delay_min_ms: number;
  rate_limit_delay_max_ms: number;
  key_selection: KeySelectionMode;
  sticky_on_cooldown: StickyOnCooldown;
  retry: Required<RetryConfig>;
  selector: Required<SelectorConfig>;
  health: Required<HealthConfig>;
  quota: Required<QuotaPersistConfig>;
}

export const ANTI_BAN_DEFAULTS: ResolvedAntiBan = {
  mode: 'conservative',
  max_concurrent: 1,
  min_interval_ms: 1000,
  rate_limit_delay_min_ms: 5000,
  rate_limit_delay_max_ms: 10000,
  key_selection: 'sticky',
  sticky_on_cooldown: 'fallthrough',
  retry: {
    max_attempts: 3,
    max_total_ms: 30000,
    retry_on_rate_limit: true,
    retry_on_transient: true
  },
  selector: {
    min_weight: 0.05
  },
  health: {
    window_ms: 300000,
    rate_limit_penalty_per_event: 0.15,
    rate_limit_penalty_floor: 0.2,
    transient_penalty_per_event: 0.10,
    transient_penalty_floor: 0.3,
    consecutive_penalty_per_event: 0.20,
    consecutive_penalty_floor: 0.1,
    fresh_success_boost: 1.05,
    fresh_success_window_ms: 60000,
    score_floor: 0.1,
    score_ceiling: 1.05
  },
  quota: {
    persist_every_n_requests: 50,
    persist_critical_threshold: 0.85,
    usage_file: 'runtime_usage.json'
  }
};

const MODE_PRESETS: Record<AntiBanMode, Partial<ResolvedAntiBan>> = {
  throughput: {
    max_concurrent: 3,
    min_interval_ms: 100,
    rate_limit_delay_min_ms: 1000,
    rate_limit_delay_max_ms: 3000
  },
  conservative: {
    max_concurrent: 1,
    min_interval_ms: 1000,
    rate_limit_delay_min_ms: 5000,
    rate_limit_delay_max_ms: 10000
  }
};

export function resolveAntiBanConfig(
  primary?: AntiBanConfig | null,
  fallback?: AntiBanConfig | null
): ResolvedAntiBan {
  const base: ResolvedAntiBan = {
    ...ANTI_BAN_DEFAULTS,
    retry: { ...ANTI_BAN_DEFAULTS.retry },
    selector: { ...ANTI_BAN_DEFAULTS.selector },
    health: { ...ANTI_BAN_DEFAULTS.health },
    quota: { ...ANTI_BAN_DEFAULTS.quota }
  };
  const mode = primary?.mode ?? fallback?.mode ?? base.mode;
  applyPartial(base, MODE_PRESETS[mode] ?? {});
  applyPartial(base, fallback ?? {});
  applyPartial(base, primary ?? {});
  base.mode = mode;
  clamp(base);
  return base;
}

function applyPartial(target: ResolvedAntiBan, src: Partial<AntiBanConfig> | Partial<ResolvedAntiBan>): void {
  const t = target as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || v === null) continue;
    if (k === 'retry' || k === 'selector' || k === 'health' || k === 'quota') {
      Object.assign(t[k] as object, v);
    } else {
      t[k] = v;
    }
  }
}

function clamp(c: ResolvedAntiBan): void {
  c.max_concurrent = Math.max(1, Math.trunc(Number(c.max_concurrent) || 1));
  c.min_interval_ms = Math.max(0, Math.trunc(Number(c.min_interval_ms) || 0));
  c.rate_limit_delay_min_ms = Math.max(0, Math.trunc(Number(c.rate_limit_delay_min_ms) || 0));
  c.rate_limit_delay_max_ms = Math.max(c.rate_limit_delay_min_ms, Math.trunc(Number(c.rate_limit_delay_max_ms) || 0));
  c.retry.max_attempts = Math.max(1, Math.trunc(Number(c.retry.max_attempts) || 1));
  c.retry.max_total_ms = Math.max(0, Math.trunc(Number(c.retry.max_total_ms) || 0));
  c.selector.min_weight = Math.max(0, Math.min(1, Number(c.selector.min_weight) || 0));
  c.health.window_ms = Math.max(1000, Math.trunc(Number(c.health.window_ms) || 1000));
  c.health.fresh_success_window_ms = Math.max(0, Math.trunc(Number(c.health.fresh_success_window_ms) || 0));
  c.health.score_floor = Math.max(0, Math.min(1, Number(c.health.score_floor) || 0));
  c.health.score_ceiling = Math.max(c.health.score_floor, Number(c.health.score_ceiling) || 1);
  c.quota.persist_every_n_requests = Math.max(0, Math.trunc(Number(c.quota.persist_every_n_requests) || 0));
  c.quota.persist_critical_threshold = Math.max(0, Math.min(1, Number(c.quota.persist_critical_threshold) || 0.85));
}
