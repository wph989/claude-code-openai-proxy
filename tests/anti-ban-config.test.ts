import { describe, it, expect } from 'vitest';
import { normalizeRuntimeConfig } from '../src/models.js';
import { resolveAntiBanConfig, ANTI_BAN_DEFAULTS } from '../src/services/anti-ban-config.js';

describe('resolveAntiBanConfig', () => {
  it('returns full defaults when no config provided', () => {
    const cfg = resolveAntiBanConfig();
    expect(cfg.key_selection).toBe(ANTI_BAN_DEFAULTS.key_selection);
    expect(cfg.retry.max_attempts).toBe(ANTI_BAN_DEFAULTS.retry.max_attempts);
  });

  it('deep-merges provider override on top of global', () => {
    const merged = resolveAntiBanConfig(
      { retry: { max_attempts: 5 } },
      { min_interval_ms: 2000 }
    );
    expect(merged.retry.max_attempts).toBe(5);
    expect(merged.min_interval_ms).toBe(2000);
    expect(merged.retry.max_total_ms).toBe(ANTI_BAN_DEFAULTS.retry.max_total_ms);
  });

  it('mode=throughput applies preset when explicit fields missing', () => {
    const cfg = resolveAntiBanConfig({ mode: 'throughput' });
    expect(cfg.max_concurrent).toBeGreaterThan(1);
    expect(cfg.min_interval_ms).toBeLessThan(1000);
  });

  it('explicit fields override mode preset', () => {
    const cfg = resolveAntiBanConfig({ mode: 'throughput', max_concurrent: 1 });
    expect(cfg.max_concurrent).toBe(1);
  });

  it('clamps negative numbers to 0 / 1', () => {
    const cfg = resolveAntiBanConfig({ min_interval_ms: -100, max_concurrent: -5 });
    expect(cfg.min_interval_ms).toBe(0);
    expect(cfg.max_concurrent).toBe(1);
  });

  it('rate_limit_delay_max never below min', () => {
    const cfg = resolveAntiBanConfig({ rate_limit_delay_min_ms: 5000, rate_limit_delay_max_ms: 1000 });
    expect(cfg.rate_limit_delay_max_ms).toBe(5000);
  });

  it('keeps advanced anti-ban config when normalizing runtime config', () => {
    const cfg = normalizeRuntimeConfig({
      providers: [
        {
          provider_id: 'p1',
          provider_type: 'openai_compatible',
          base_url: 'https://example.com/v1',
          anti_ban: {
            key_selection: 'balanced',
            retry: { max_attempts: 5, retry_on_transient: false }
          }
        }
      ],
      models: [],
      anti_ban: {
        mode: 'throughput',
        sticky_on_cooldown: 'wait'
      }
    });

    expect(cfg.anti_ban).toEqual({
      mode: 'throughput',
      sticky_on_cooldown: 'wait'
    });
    expect(cfg.providers[0].anti_ban).toEqual({
      key_selection: 'balanced',
      retry: { max_attempts: 5, retry_on_transient: false }
    });
  });
});
