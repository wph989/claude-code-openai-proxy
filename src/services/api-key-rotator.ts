import { KeyRotationStrategy } from '../models.js';

export class ApiKeyRotator {
  private _keys: string[];
  private _strategy: KeyRotationStrategy;
  private rrCounter: number = 0;
  private on429Index: number = 0;
  private cooldowns: Map<number, number> = new Map();

  constructor(keys: string[], strategy: KeyRotationStrategy) {
    this._keys = keys;
    this._strategy = strategy;
  }

  get keys(): string[] {
    return this._keys;
  }

  get keyCount(): number {
    return this._keys.length;
  }

  get strategy(): KeyRotationStrategy {
    return this._strategy;
  }

  pick(): string {
    if (this._strategy === KeyRotationStrategy.on_429) {
      const now = Date.now();
      for (let i = 0; i < this._keys.length; i++) {
        const idx = (this.on429Index + i) % this._keys.length;
        const cooldownUntil = this.cooldowns.get(idx);
        if (cooldownUntil == null || now >= cooldownUntil) {
          this.on429Index = idx;
          return this._keys[idx];
        }
      }
      return this._keys[this.on429Index];
    }

    const idx = this.rrCounter % this._keys.length;
    this.rrCounter++;
    return this._keys[idx];
  }

  mark429(key: string): void {
    if (this._strategy !== KeyRotationStrategy.on_429) return;
    const idx = this._keys.indexOf(key);
    if (idx === -1) return;
    this.cooldowns.set(idx, Date.now() + 60_000);
    this.on429Index = (idx + 1) % this._keys.length;
  }

  allCoolingDown(): boolean {
    if (this._strategy !== KeyRotationStrategy.on_429) return false;
    const now = Date.now();
    return this._keys.every((_, i) => {
      const cooldownUntil = this.cooldowns.get(i);
      return cooldownUntil != null && now < cooldownUntil;
    });
  }
}
