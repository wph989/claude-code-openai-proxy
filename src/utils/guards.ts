/**
 * 通用类型守卫和数值转换工具。
 *
 * 从多个模块中提取的重复工具函数，统一维护。
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 将任意值转为整数（截断小数），非有限数返回 0。
 */
export function toInt(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}

/**
 * 将任意值转为非负整数，负数和非有限数返回 0。
 */
export function toNonNegInt(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : 0;
}
