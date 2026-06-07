import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: 去掉 I L O U

/**
 * 生成 10 字符的稳定 id（约 50 bits 熵，1k key 量级下碰撞概率忽略不计）。
 * 用于 state / usage 持久化主键，与上游 token 字面量解耦，避免改 key 值丢历史。
 */
export function nanoid(length = 10): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] & 31];
  }
  return out;
}
