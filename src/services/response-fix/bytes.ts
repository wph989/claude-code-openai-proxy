export function toBuffer(body: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(body);
}
