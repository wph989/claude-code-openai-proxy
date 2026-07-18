import { isPlainObject } from '../../utils/guards.js';

/**
 * OpenAI SSE 会在多个事件层级重复携带 model。这里按完整字段值改写客户端别名，
 * 既隐藏内部模型映射，也避免字符串替换误伤生成文本或工具参数。
 */
export class SseModelAliasRewriter {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private finished = false;

  constructor(
    private readonly upstreamModel: string,
    private readonly clientModel: string,
  ) {}

  push(chunk: Uint8Array): string {
    if (this.finished) throw new Error('SSE 模型别名改写器已结束，不能继续写入。');
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  finish(): string {
    if (this.finished) return '';
    this.buffer += this.decoder.decode();
    this.finished = true;
    return this.drain(true);
  }

  private drain(flushRemainder: boolean): string {
    const lines = this.buffer.split('\n');
    this.buffer = flushRemainder ? '' : lines.pop() ?? '';
    if (flushRemainder && lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const rewritten = lines.map((line) => this.rewriteLine(line));
    let output = rewritten.join('\n');
    if (!flushRemainder && rewritten.length > 0) output += '\n';
    return output;
  }

  private rewriteLine(rawLine: string): string {
    const carriageReturn = rawLine.endsWith('\r') ? '\r' : '';
    const line = carriageReturn ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) return rawLine;
    const prefixLength = line.indexOf(':') + 1;
    const whitespace = line.slice(prefixLength).match(/^\s*/)?.[0] ?? '';
    const payload = line.slice(prefixLength + whitespace.length);
    if (!payload || payload === '[DONE]' || this.upstreamModel === this.clientModel) return rawLine;

    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return rawLine;
    }
    if (!rewriteModelFields(value, this.upstreamModel, this.clientModel)) return rawLine;
    return `${line.slice(0, prefixLength)}${whitespace}${JSON.stringify(value)}${carriageReturn}`;
  }
}

function rewriteModelFields(value: unknown, upstreamModel: string, clientModel: string, depth = 0): boolean {
  // 非可信上游 JSON 可能构造极深对象；深度上限避免递归耗尽调用栈。
  if (depth > 32) return false;
  if (Array.isArray(value)) {
    return value.reduce(
      (changed, item) => rewriteModelFields(item, upstreamModel, clientModel, depth + 1) || changed,
      false,
    );
  }
  if (!isPlainObject(value)) return false;
  let changed = false;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'model' && item === upstreamModel) {
      value[key] = clientModel;
      changed = true;
      continue;
    }
    if (rewriteModelFields(item, upstreamModel, clientModel, depth + 1)) changed = true;
  }
  return changed;
}
