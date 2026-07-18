import { isPlainObject, toNonNegInt } from '../../utils/guards.js';

export interface StreamTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * 跨 chunk 提取 OpenAI/Anthropic SSE 中累计 usage，只保留数字，不保存事件正文。
 * usage 通常位于最终事件，但解析器必须支持任意网络分块边界。
 */
export class SseUsageTracker {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private finished = false;

  push(chunk: Buffer | Uint8Array | string): void {
    if (this.finished) {
      throw new Error('SSE usage tracker 已结束，不能继续写入。');
    }
    // 网络分块可能落在 UTF-8 多字节字符中间，流式 decoder 可避免整条 JSON 被替换字符破坏。
    const text = typeof chunk === 'string'
      ? chunk
      : this.decoder.decode(chunk, { stream: true });
    this.consume(text);
  }

  finish(): StreamTokenUsage {
    if (!this.finished) {
      this.consume(this.decoder.decode());
      if (this.buffer.length > 0) {
        this.consumeLine(this.buffer.replace(/\r$/, ''));
        this.buffer = '';
      }
      this.finished = true;
    }
    return this.getUsage();
  }

  getUsage(): StreamTokenUsage {
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }

  private consume(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      this.consumeLine(rawLine.replace(/\r$/, ''));
    }
  }

  private consumeLine(line: string): void {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    const message = isPlainObject(event.message) ? event.message : null;
    const usage = isPlainObject(event.usage)
      ? event.usage
      : message && isPlainObject(message.usage) ? message.usage : null;
    if (!usage) return;
    this.inputTokens = Math.max(
      this.inputTokens,
      toNonNegInt(usage.input_tokens ?? usage.prompt_tokens),
    );
    this.outputTokens = Math.max(
      this.outputTokens,
      toNonNegInt(usage.output_tokens ?? usage.completion_tokens),
    );
  }
}
