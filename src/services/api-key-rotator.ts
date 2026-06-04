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
  note?: string;
};

export class ApiKeyRotator {
  private _keys: ApiKeyEntry[];
  private _strategy: KeyRotationStrategy;
  private _autoDisable: boolean;
  private rrCounter: number = 0;
  private on429Index: number = 0;
  private activeIndex: number | null = null;
  private _onChange?: (key: string, patch: KeyStateChange) => void;

  constructor(keys: ApiKeyEntry[], strategy: KeyRotationStrategy, autoDisable: boolean = true) {
    this._keys = keys;
    this._strategy = strategy;
    this._autoDisable = autoDisable;
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
    if (!entry.note) {
      patch.note = `auto disabled: ${errorMessage}`;
    }
    if (this._strategy === KeyRotationStrategy.on_429) {
      this.on429Index = (idx + 1) % this._keys.length;
    }
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
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
      if (!entry.note) {
        patch.note = reason;
      }
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
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  getKeys(): ApiKeyEntry[] {
    return this._keys;
  }
}
