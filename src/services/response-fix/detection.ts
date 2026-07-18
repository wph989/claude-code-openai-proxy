import { toBuffer } from './bytes.js';

/**
 * 粗判：响应头几个字节是否像 OpenAI chat.completion.chunk 流。
 * 命中任一标记或 SSE 首行是 data: {"id":"chatcmpl-...} 即视为 OpenAI 风格。
 */
export function looksLikeOpenAISSE(body: Buffer | Uint8Array | string): boolean {
  const buf = toBuffer(body);
  if (buf.length === 0) return false;
  const head = buf.subarray(0, 4096).toString('utf8');
  const markers = [
    '"object":"chat.completion.chunk"',
    '"object": "chat.completion.chunk"',
    '"object":"chat.completion"',
    '"object": "chat.completion"',
  ];
  if (markers.some((marker) => head.includes(marker))) return true;
  const stripped = head.replace(/^\s+/, '');
  return /^data:\s*\{"id":"chatcmpl-/.test(stripped) || /^data:\{"id":"chatcmpl-/.test(stripped);
}

/**
 * 粗判：响应体已经是 Anthropic SSE 形态，但 id 仍是 OpenAI 风格。
 */
export function looksLikeBrokenAnthropicSSE(body: Buffer | Uint8Array | string): boolean {
  const buf = toBuffer(body);
  if (buf.length === 0) return false;
  const head = buf.subarray(0, 16384).toString('utf8');
  const hasAnthropicFrame =
    head.includes('event: message_start') ||
    head.includes('"type":"message_start"') ||
    head.includes('"type": "message_start"');
  const hasOpenAiId =
    head.includes('"id":"chatcmpl-') || head.includes('"id": "chatcmpl-');
  return hasAnthropicFrame && hasOpenAiId;
}

export function looksLikeAnthropicSSE(body: Buffer | Uint8Array | string): boolean {
  const buf = toBuffer(body);
  if (buf.length === 0) return false;
  const head = buf.subarray(0, 16384).toString('utf8');
  return (
    head.includes('event: message_start') ||
    head.includes('event: content_block_start') ||
    head.includes('"type":"message_start"') ||
    head.includes('"type": "message_start"') ||
    head.includes('"type":"content_block_start"') ||
    head.includes('"type": "content_block_start"')
  );
}
