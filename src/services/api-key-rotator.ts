import type { ApiKeyEntry } from '../models.js';
import { KeyRotationStrategy } from '../models.js';
import { settings } from '../config.js';

export type KeyStateChange = {
  enabled?: boolean;
  error_count?: number;
  disabled_at?: number | null;
  last_error_at?: number | null;
  last_error_message?: string | null;
  auto_disabled_at?: number | null;
};

export class ApiKeyRotator {
  private _keys: ApiKeyEntry[];
  private _strategy: KeyRotationStrategy;
  private rrCounter: number = 0;
  private on429Index: number = 0;
  private cooldowns: Map<number, number> = new Map();
  private _onChange?: (key: string, patch: KeyStateChange) => void;

  constructor(keys: ApiKeyEntry[], strategy: KeyRotationStrategy) {
    this._keys = keys;
    this._strategy = strategy;
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

  pick(): string | undefined {
    if (this._keys.length === 0) return undefined;

    if (this._strategy === KeyRotationStrategy.on_429) {
      const now = Date.now();
      for (let i = 0; i < this._keys.length; i++) {
        const idx = (this.on429Index + i) % this._keys.length;
        const entry = this._keys[idx];
        if (!entry.enabled) continue;
        const cooldownUntil = this.cooldowns.get(idx);
        if (cooldownUntil == null || now >= cooldownUntil) {
          this.on429Index = idx;
          return entry.key;
        }
      }
      return undefined;
    }

    for (let i = 0; i < this._keys.length; i++) {
      const idx = (this.rrCounter + i) % this._keys.length;
      const entry = this._keys[idx];
      if (entry.enabled) {
        this.rrCounter = idx + 1;
        return entry.key;
      }
    }
    return undefined;
  }

  markError(key: string, errorMessage: string, is429: boolean): void {
    const idx = this._keys.findIndex((k) => k.key === key);
    if (idx === -1) return;

    const entry = this._keys[idx];
    const patch: KeyStateChange = {
      error_count: entry.error_count + 1,
      last_error_at: Date.now(),
      last_error_message: errorMessage
    };

    if (is429 && this._strategy === KeyRotationStrategy.on_429) {
      this.cooldowns.set(idx, Date.now() + 60_000);
      this.on429Index = (idx + 1) % this._keys.length;
    }

    if (entry.error_count + 1 >= settings.keyMaxErrors && entry.enabled) {
      patch.enabled = false;
      patch.auto_disabled_at = Date.now();
    }

    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  allUnavailable(): boolean {
    if (this._keys.length === 0) return true;
    const now = Date.now();
    return this._keys.every((entry, i) => {
      if (!entry.enabled) return true;
      const cooldownUntil = this.cooldowns.get(i);
      return cooldownUntil != null && now < cooldownUntil;
    });
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
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  disableKey(key: string): void {
    const entry = this._keys.find((k) => k.key === key);
    if (!entry) return;
    const patch: KeyStateChange = {
      enabled: false,
      disabled_at: Date.now()
    };
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
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  getKeys(): ApiKeyEntry[] {
    return this._keys;
  }
}
