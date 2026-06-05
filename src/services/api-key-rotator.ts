import type { AntiBanConfig, ApiKeyEntry } from '../models.js';
import { KeyRotationStrategy } from '../models.js';
import { settings } from '../config.js';

export type KeyErrorCategory = 'hard_limit' | 'rate_limit' | 'transient' | 'network' | null;

export type KeyLease = {
  key: string;
};

export type KeyRuntimeStatus = ApiKeyEntry & {
  status: 'available' | 'delayed' | 'disabled';
  active_requests: number;
  next_available_at: number | null;
  last_error_category: KeyErrorCategory;
  disabled_reason: string | null;
};

export type KeyStateChange = {
  enabled?: boolean;
  error_count?: number;
  disabled_at?: number | null;
  last_error_at?: number | null;
  last_error_message?: string | null;
  auto_disabled_at?: number | null;
  note?: string;
};

export class ApiKeyRotator {
  private _keys: ApiKeyEntry[];
  private _strategy: KeyRotationStrategy;
  private _autoDisable: boolean;
  private _antiBan: Required<AntiBanConfig>;
  private rrCounter: number = 0;
  private on429Index: number = 0;
  private activeIndex: number | null = null;
  private runtime = new Map<string, {
    activeRequests: number;
    nextAvailableAt: number | null;
    lastSentAt: number | null;
    lastErrorCategory: KeyErrorCategory;
  }>();
  private _onChange?: (key: string, patch: KeyStateChange) => void;

  constructor(keys: ApiKeyEntry[], strategy: KeyRotationStrategy, autoDisable: boolean = true, antiBan?: AntiBanConfig) {
    this._keys = keys;
    this._strategy = strategy;
    this._autoDisable = autoDisable;
    this._antiBan = resolveAntiBanConfig(antiBan);
  }

  set onChange(fn: ((key: string, patch: KeyStateChange) => void) | undefined) {
    this._onChange = fn;
  }

  get keys(): ApiKeyEntry[] {
    return this._keys;
  }

  get keyCount(): number {
    return this._keys.length;
  }

  get strategy(): KeyRotationStrategy {
    return this._strategy;
  }

  get antiBan(): Required<AntiBanConfig> {
    return this._antiBan;
  }

  pick(): string | undefined {
    if (this._keys.length === 0) return undefined;

    if (this._strategy === KeyRotationStrategy.on_429) {
      for (let i = 0; i < this._keys.length; i++) {
        const idx = (this.on429Index + i) % this._keys.length;
        const entry = this._keys[idx];
        if (entry.enabled) {
          this.on429Index = idx;
          return entry.key;
        }
      }
      return undefined;
    }

    if (this.activeIndex != null && this._keys[this.activeIndex]?.enabled) {
      return this._keys[this.activeIndex].key;
    }

    const start = this.activeIndex == null ? this.rrCounter : this.activeIndex + 1;
    for (let i = 0; i < this._keys.length; i++) {
      const idx = (start + i) % this._keys.length;
      const entry = this._keys[idx];
      if (entry.enabled) {
        this.activeIndex = idx;
        this.rrCounter = idx;
        return entry.key;
      }
    }
    return undefined;
  }

  async acquire(): Promise<KeyLease> {
    while (true) {
      const key = this.pick();
      if (!key) {
        throw new Error('没有可用的 API Key');
      }
      const state = this.getRuntimeState(key);
      const entry = this._keys.find((item) => item.key === key);
      if (!entry?.enabled) {
        await sleep(5);
        continue;
      }
      if (state.activeRequests >= this._antiBan.max_concurrent) {
        await sleep(5);
        continue;
      }
      const now = Date.now();
      const nextByDelay = state.nextAvailableAt ?? 0;
      const nextByInterval = state.lastSentAt == null ? 0 : state.lastSentAt + this._antiBan.min_interval_ms;
      const waitMs = Math.max(nextByDelay, nextByInterval) - now;
      if (waitMs > 0) {
        await sleep(waitMs);
        continue;
      }
      state.activeRequests++;
      state.lastSentAt = Date.now();
      if (state.nextAvailableAt != null && state.nextAvailableAt <= Date.now()) {
        state.nextAvailableAt = null;
      }
      return { key };
    }
  }

  release(lease: KeyLease | string | undefined): void {
    const key = typeof lease === 'string' ? lease : lease?.key;
    if (!key) return;
    const state = this.getRuntimeState(key);
    state.activeRequests = Math.max(0, state.activeRequests - 1);
  }

  markError(key: string, errorMessage: string): void {
    const idx = this._keys.findIndex((k) => k.key === key);
    if (idx === -1) return;

    const entry = this._keys[idx];
    const patch: KeyStateChange = {
      error_count: entry.error_count + 1,
      last_error_at: Date.now(),
      last_error_message: errorMessage
    };

    if (settings.keyAutoDisable && this._autoDisable && entry.error_count + 1 >= settings.keyMaxErrors && entry.enabled) {
      patch.enabled = false;
      patch.auto_disabled_at = Date.now();
    }
    this.getRuntimeState(key).lastErrorCategory = 'transient';

    if (this._strategy === KeyRotationStrategy.on_429) {
      this.on429Index = (idx + 1) % this._keys.length;
    }

    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  markQuotaError(key: string, errorMessage: string): void {
    const idx = this._keys.findIndex((k) => k.key === key);
    if (idx === -1) return;

    const entry = this._keys[idx];
    const now = Date.now();
    const patch: KeyStateChange = {
      enabled: false,
      error_count: entry.error_count + 1,
      last_error_at: now,
      last_error_message: errorMessage,
      auto_disabled_at: now
    };
    this.getRuntimeState(key).lastErrorCategory = 'hard_limit';
    if (this._strategy === KeyRotationStrategy.on_429) {
      this.on429Index = (idx + 1) % this._keys.length;
    }
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  markRateLimited(key: string, errorMessage: string): void {
    const idx = this._keys.findIndex((k) => k.key === key);
    if (idx === -1) return;

    const entry = this._keys[idx];
    const now = Date.now();
    const state = this.getRuntimeState(key);
    const delay = randomBetween(this._antiBan.rate_limit_delay_min_ms, this._antiBan.rate_limit_delay_max_ms);
    state.nextAvailableAt = now + delay;
    state.lastErrorCategory = 'rate_limit';
    const patch: KeyStateChange = {
      error_count: entry.error_count + 1,
      last_error_at: now,
      last_error_message: errorMessage
    };
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  markNetworkError(key: string, errorMessage: string): void {
    this.getRuntimeState(key).lastErrorCategory = 'network';
    this.markError(key, errorMessage);
    this.getRuntimeState(key).lastErrorCategory = 'network';
  }

  markSuccess(key: string): void {
    const idx = this._keys.findIndex((k) => k.key === key);
    if (idx === -1) return;
    const entry = this._keys[idx];
    if (entry.error_count === 0 && entry.last_error_at === null) return;
    const patch: KeyStateChange = {
      error_count: 0,
      last_error_at: null,
      last_error_message: null
    };
    this.getRuntimeState(key).lastErrorCategory = null;
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  allUnavailable(): boolean {
    if (this._keys.length === 0) return true;
    return this._keys.every((entry) => !entry.enabled);
  }

  hasAvailableKey(): boolean {
    return !this.allUnavailable();
  }

  enableKey(key: string): void {
    const entry = this._keys.find((k) => k.key === key);
    if (!entry) return;
    const patch: KeyStateChange = {
      enabled: true,
      error_count: 0,
      disabled_at: null,
      auto_disabled_at: null
    };
    const state = this.getRuntimeState(key);
    state.nextAvailableAt = null;
    state.lastErrorCategory = null;
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  disableKey(key: string, reason?: string): void {
    const entry = this._keys.find((k) => k.key === key);
    if (!entry) return;
    const patch: KeyStateChange = {
      enabled: false,
      disabled_at: Date.now()
    };
    if (reason) {
      patch.last_error_at = Date.now();
      patch.last_error_message = reason;
      this.getRuntimeState(key).lastErrorCategory = 'hard_limit';
    }
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  resetErrorCount(key: string): void {
    const entry = this._keys.find((k) => k.key === key);
    if (!entry) return;
    const patch: KeyStateChange = {
      error_count: 0,
      enabled: true,
      disabled_at: null,
      auto_disabled_at: null,
      last_error_at: null,
      last_error_message: null
    };
    const state = this.getRuntimeState(key);
    state.nextAvailableAt = null;
    state.lastErrorCategory = null;
    state.activeRequests = 0;
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  getKeys(): ApiKeyEntry[] {
    return this._keys;
  }

  getKeyStatuses(): KeyRuntimeStatus[] {
    const now = Date.now();
    return this._keys.map((entry) => {
      const state = this.getRuntimeState(entry.key);
      const delayed = entry.enabled && state.nextAvailableAt != null && state.nextAvailableAt > now;
      return {
        ...entry,
        status: !entry.enabled ? 'disabled' : delayed ? 'delayed' : 'available',
        active_requests: state.activeRequests,
        next_available_at: delayed ? state.nextAvailableAt : null,
        last_error_category: state.lastErrorCategory,
        disabled_reason: !entry.enabled ? entry.last_error_message || null : null
      };
    });
  }

  private getRuntimeState(key: string): {
    activeRequests: number;
    nextAvailableAt: number | null;
    lastSentAt: number | null;
    lastErrorCategory: KeyErrorCategory;
  } {
    let state = this.runtime.get(key);
    if (!state) {
      state = {
        activeRequests: 0,
        nextAvailableAt: null,
        lastSentAt: null,
        lastErrorCategory: null
      };
      this.runtime.set(key, state);
    }
    return state;
  }
}

function resolveAntiBanConfig(config?: AntiBanConfig): Required<AntiBanConfig> {
  const mode = config?.mode ?? settings.antiBanMode;
  const defaults = mode === 'throughput'
    ? { max_concurrent: 3, min_interval_ms: 100, rate_limit_delay_min_ms: 1000, rate_limit_delay_max_ms: 3000 }
    : { max_concurrent: 1, min_interval_ms: 1000, rate_limit_delay_min_ms: 5000, rate_limit_delay_max_ms: 10000 };
  const maxConcurrent = Math.max(1, Math.trunc(config?.max_concurrent ?? settings.keyMaxConcurrent ?? defaults.max_concurrent));
  const minInterval = Math.max(0, Math.trunc(config?.min_interval_ms ?? settings.keyMinIntervalMs ?? defaults.min_interval_ms));
  const delayMin = Math.max(0, Math.trunc(config?.rate_limit_delay_min_ms ?? settings.key429DelayMinMs ?? defaults.rate_limit_delay_min_ms));
  const delayMax = Math.max(delayMin, Math.trunc(config?.rate_limit_delay_max_ms ?? settings.key429DelayMaxMs ?? defaults.rate_limit_delay_max_ms));
  return {
    mode,
    max_concurrent: maxConcurrent,
    min_interval_ms: minInterval,
    rate_limit_delay_min_ms: delayMin,
    rate_limit_delay_max_ms: delayMax
  };
}

function randomBetween(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
