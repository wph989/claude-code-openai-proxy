/**
 * 响应修复：把上游（oneapi / 自建网关 / 兼容代理）返回的"半成品 Anthropic 响应"和
 * "OpenAI 兼容响应"统一修成 Claude Code 客户端能直接消费的形态。
 *
 * 主要修复点：
 *   1. id 为 chatcmpl-XXX 时换成 msg_<hex>，避免 Claude Code 客户端断言失败。
 *   2. message_start.message.usage 补齐五字段（input_tokens / cache_creation_input_tokens
 *      / cache_read_input_tokens / output_tokens / server_tool_use）。
 *   3. content_block_start / content_block_delta / content_block_stop 的 index 重新连续编号。
 *   4. message_delta.usage.output_tokens 兜底为 0。
 *   5. 缺 content_block_stop / message_delta / message_stop 时按状态机补齐。
 *   6. （可选）丢弃 type=thinking 的整段块。
 *
 * 设计上对标项目根目录的 http_forward.py：相同的修复语义、相似的转换函数形态。
 */

import { createId } from '../utils/id.js';
import { isPlainObject, toInt } from '../utils/guards.js';
import { mapFinishReason } from './transformers.js';

// OpenAI 兼容的 stop_reason → Anthropic 的映射（与 transformers.ts 保持一致，避免重复实现）。
// 这里直接复用 transformers.ts 的 mapFinishReason。

interface SseEvent {
  event?: string;
  data: string;
}

export interface FixInfo {
  newId: string;
  droppedThinkingIndices: number[];
  renumbered: Record<number, number>;
  inserted: { contentBlockStop: number[]; messageDelta: boolean; messageStop: boolean };
}

function toBuffer(body: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(body);
}

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
  if (markers.some((m) => head.includes(m))) return true;
  const stripped = head.replace(/^\s+/, '');
  return /^data:\s*\{"id":"chatcmpl-/.test(stripped) || /^data:\{"id":"chatcmpl-/.test(stripped);
}

/**
 * 粗判：响应体已经是 Anthropic SSE 形态（含 message_start），但 id 是 OpenAI 风格的 chatcmpl-。
 * 这是 oneapi 等网关在把 OpenAI 响应包成 Anthropic SSE 时的常见"半成品"。
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

/**
 * 把 SseEvent[] 渲染回 SSE bytes。每条事件以 event: / data: 双行 + 空行结束。
 */
function renderSseEvents(events: SseEvent[]): Buffer {
  if (events.length === 0) return Buffer.from('');
  const lines: string[] = [];
  for (const ev of events) {
    lines.push(`event: ${ev.event ?? 'message'}`);
    lines.push(`data: ${ev.data ?? '{}'}`);
    lines.push(''); // 空行 = 事件分隔
  }
  // 流式修复会把单个事件分多次 write；末尾必须再补一个换行，
  // 否则下一次 write 的 event: 会紧跟在 data 行后面，客户端不会派发上一条事件。
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/**
 * 流式状态机：逐事件修补"半成品 Anthropic SSE"（上游已发 message_start 但 id 是 chatcmpl- / 缺 usage / index 乱序）。
 *
 * 用法：
 *   const fixer = new StreamingAnthropicSSEFixer({ dropThinking: true });
 *   upstreamStream.on('data', chunk => {
 *     const fixed = fixer.push(chunk);
 *     if (fixed) downstreamRes.write(fixed);
 *   });
 *   upstreamStream.on('end', () => {
 *     const tail = fixer.finalize();
 *     downstreamRes.write(tail);
 *     downstreamRes.end();
 *   });
 */
export class StreamingAnthropicSSEFixer {
  private dropThinking: boolean;
  private newId: string;
  private buffer = '';
  private current: SseEvent = { data: '' }; // 跨 push 调用保持，直到遇到空行 flush
  private remap = new Map<number, number>();
  private nextIndex = 0;
  private thinkingIndices = new Set<number>();
  private droppedBlockIndices = new Set<number>();
  private blockTypes = new Map<number, string>();
  private firstPass = true; // 第一遍扫描 thinking 块
  private openedIndices: number[] = [];
  private closedIndices = new Set<number>();
  private sawMessageStart = false;
  private sawMessageDelta = false;
  private sawMessageStop = false;
  private droppedIndices: number[] = [];

  constructor(options: { dropThinking?: boolean; newId?: string } = {}) {
    this.dropThinking = options.dropThinking !== false;
    this.newId = options.newId ?? createId('msg');
  }

  /**
   * 喂入 SSE 分块（可能不在事件边界），返回已修复的完整事件（可能为空）。
   */
  push(chunk: Buffer | Uint8Array | string): Buffer | null {
    this.buffer += toBuffer(chunk).toString('utf8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? ''; // 保留不完整的最后一行
    const ready: SseEvent[] = [];
    const flush = () => {
      if (this.current.data || this.current.event) {
        ready.push({ event: this.current.event, data: this.current.data });
        this.current = { data: '' }; // 重置
      }
    };
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (line === '') {
        flush();
        continue;
      }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        this.current.event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const piece = line.slice(5).trimStart();
        this.current.data = this.current.data ? `${this.current.data}\n${piece}` : piece;
      }
    }
    if (ready.length === 0) return null;

    // 第一遍：扫描 thinking 块的 index
    if (this.firstPass) {
      for (const ev of ready) {
        if (ev.event !== 'content_block_start') continue;
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(ev.data); } catch { continue; }
        if (!parsed) continue;
        const block = (parsed.content_block as Record<string, unknown> | undefined) || null;
        if (block && block.type === 'thinking') {
          this.thinkingIndices.add(Number(parsed.index));
        }
      }
      // 第一批事件处理完后关闭第一遍标志（后续 thinking 块仍会动态加入 thinkingIndices）
      this.firstPass = false;
    }

    const fixed: SseEvent[] = [];
    for (const ev of ready) {
      const processed = this.processEvent(ev);
      if (processed) fixed.push(processed);
    }
    return fixed.length > 0 ? renderSseEvents(fixed) : null;
  }

  /**
   * 流结束时补齐缺失的收尾事件（content_block_stop / message_delta / message_stop）。
   */
  finalize(): Buffer {
    if (!this.sawMessageStart) {
      return Buffer.from('');
    }
    const tail: SseEvent[] = [];
    for (const idx of this.openedIndices) {
      if (this.closedIndices.has(idx)) continue;
      tail.push({
        event: 'content_block_stop',
        data: JSON.stringify({ type: 'content_block_stop', index: idx }),
      });
    }
    if (!this.sawMessageDelta) {
      tail.push({
        event: 'message_delta',
        data: JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 0 },
        }),
      });
    }
    if (!this.sawMessageStop) {
      tail.push({
        event: 'message_stop',
        data: JSON.stringify({ type: 'message_stop' }),
      });
    }
    return renderSseEvents(tail);
  }

  getFixInfo(): FixInfo {
    return {
      newId: this.newId,
      droppedThinkingIndices: this.droppedIndices.sort((a, b) => a - b),
      renumbered: Object.fromEntries(this.remap),
      inserted: {
        contentBlockStop: this.openedIndices.filter(i => !this.closedIndices.has(i)),
        messageDelta: !this.sawMessageDelta,
        messageStop: !this.sawMessageStop,
      },
    };
  }

  hasMessageStart(): boolean {
    return this.sawMessageStart;
  }

  private processEvent(ev: SseEvent): SseEvent | null {
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(ev.data); } catch { return ev; }
    if (!parsed) return ev;
    const name = ev.event ?? (typeof parsed.type === 'string' ? parsed.type : undefined);

    // 1) 替换 id（所有事件的 JSON 都可能含 id 字段）
    if (typeof parsed.id === 'string' && parsed.id.startsWith('chatcmpl-')) {
      parsed.id = this.newId;
    }

    // 2) message_start: 补全 usage 和 message 字段
    if (name === 'message_start') {
      this.sawMessageStart = true;
      const message = (parsed.message as Record<string, unknown>) || (parsed.message = {});
      // 先替换 message.id 里的 chatcmpl-
      if (typeof message.id === 'string' && message.id.startsWith('chatcmpl-')) {
        message.id = this.newId;
      }
      const usage = (message.usage as Record<string, unknown>) || (message.usage = {});
      usage.input_tokens = usage.input_tokens ?? 0;
      usage.cache_creation_input_tokens = usage.cache_creation_input_tokens ?? 0;
      usage.cache_read_input_tokens = usage.cache_read_input_tokens ?? 0;
      usage.output_tokens = usage.output_tokens ?? 1;
      usage.server_tool_use = usage.server_tool_use ?? null;
      message.id = message.id ?? this.newId;
      message.type = message.type ?? 'message';
      message.role = message.role ?? 'assistant';
      message.content = message.content ?? [];
      message.stop_reason = message.stop_reason ?? null;
      message.stop_sequence = message.stop_sequence ?? null;
      return { event: name, data: JSON.stringify(parsed) };
    }

    // 3) message_delta: 补 usage.output_tokens
    if (name === 'message_delta') {
      this.sawMessageDelta = true;
      const usage = (parsed.usage as Record<string, unknown>) || (parsed.usage = {});
      usage.output_tokens = usage.output_tokens ?? 0;
      return { event: name, data: JSON.stringify(parsed) };
    }

    // 4) message_stop: 记录状态
    if (name === 'message_stop') {
      this.sawMessageStop = true;
      return { event: name, data: JSON.stringify(parsed) };
    }

    // 5) content_block_* 事件：thinking 块处理 + index 重编号
    if (name === 'content_block_start' || name === 'content_block_delta' || name === 'content_block_stop') {
      const idx = Number(parsed.index);
      if (!Number.isFinite(idx)) return ev;

      // 5.1) content_block_start: 首次出现时建立 remap，识别 thinking 块
      if (name === 'content_block_start') {
        const block = (parsed.content_block as Record<string, unknown> | undefined) || null;
        const blockType = typeof block?.type === 'string' ? block.type : '';
        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          this.thinkingIndices.add(idx);
          if (this.dropThinking) {
            this.droppedBlockIndices.add(idx);
            this.droppedIndices.push(idx);
            return null; // 丢弃 thinking 块的 start
          }
          // 保留但改为 text 块
          parsed.content_block = { type: 'text', text: '' };
        } else if (blockType === 'text') {
          // 兼容网关偶尔只给 type 不给 text；Claude Code 渲染 text 块时需要稳定的字符串字段。
          const textBlock = block ?? {};
          parsed.content_block = { ...textBlock, text: typeof textBlock.text === 'string' ? textBlock.text : '' };
        } else if (blockType === 'tool_use') {
          const toolBlock = block ?? {};
          parsed.content_block = {
            ...toolBlock,
            id: typeof toolBlock.id === 'string' ? toolBlock.id : createId('toolu'),
            name: typeof toolBlock.name === 'string' ? toolBlock.name : '',
            input: isPlainObject(toolBlock.input) ? toolBlock.input : {},
          };
        } else {
          // Claude Code 对未知 content block 很严格；整段丢弃比透出半成品事件更安全。
          this.droppedBlockIndices.add(idx);
          return null;
        }
        if (!this.remap.has(idx)) {
          this.remap.set(idx, this.nextIndex);
          this.nextIndex += 1;
        }
        parsed.index = this.remap.get(idx);
        this.blockTypes.set(idx, ((parsed.content_block as Record<string, unknown>).type as string) || blockType);
        this.openedIndices.push(this.remap.get(idx)!);
        return { event: name, data: JSON.stringify(parsed) };
      }

      // 5.2) content_block_delta: thinking_delta 改为 text_delta，或丢弃
      if (name === 'content_block_delta') {
        if (this.droppedBlockIndices.has(idx)) return null;
        if (this.thinkingIndices.has(idx)) {
          if (this.dropThinking) return null;
          const delta = (parsed.delta as Record<string, unknown> | undefined) || null;
          if (delta && delta.type === 'thinking_delta') {
            parsed.delta = { type: 'text_delta', text: String(delta.thinking ?? '') };
          }
        }
        if (!this.remap.has(idx)) return null;
        const delta = (parsed.delta as Record<string, unknown> | undefined) || null;
        const blockType = this.blockTypes.get(idx);
        if (!normalizeContentBlockDelta(parsed, delta, blockType)) return null;
        parsed.index = this.remap.get(idx);
        return { event: name, data: JSON.stringify(parsed) };
      }

      // 5.3) content_block_stop: 记录关闭状态，或丢弃 thinking 块
      if (name === 'content_block_stop') {
        if (this.droppedBlockIndices.has(idx) || (this.thinkingIndices.has(idx) && this.dropThinking)) return null;
        if (!this.remap.has(idx)) return null;
        const newIdx = this.remap.get(idx)!;
        parsed.index = newIdx;
        this.closedIndices.add(newIdx);
        return { event: name, data: JSON.stringify(parsed) };
      }
    }

    return name && name !== ev.event ? { event: name, data: JSON.stringify(parsed) } : ev;
  }
}

function normalizeContentBlockDelta(
  parsed: Record<string, unknown>,
  delta: Record<string, unknown> | null,
  blockType: string | undefined
): boolean {
  if (!delta || typeof delta.type !== 'string') return false;
  if (blockType === 'text') {
    if (delta.type !== 'text_delta' || typeof delta.text !== 'string') return false;
    parsed.delta = { type: 'text_delta', text: delta.text };
    return true;
  }
  if (blockType === 'tool_use') {
    if (delta.type !== 'input_json_delta' || typeof delta.partial_json !== 'string') return false;
    parsed.delta = { type: 'input_json_delta', partial_json: delta.partial_json };
    return true;
  }
  return false;
}


/**
 * 【兼容入口】一次性修补整块 SSE（非流式）。新代码推荐用 StreamingAnthropicSSEFixer。
 */
export function fixBrokenAnthropicSSE(
  body: Buffer | Uint8Array,
  options: { dropThinking?: boolean; newId?: string } = {}
): { fixed: Buffer; info: FixInfo } {
  const fixer = new StreamingAnthropicSSEFixer(options);
  const fixed1 = fixer.push(body) ?? Buffer.from('');
  const tail = fixer.finalize();
  return {
    fixed: Buffer.concat([fixed1, tail]),
    info: fixer.getFixInfo(),
  };
}

/**
 * 把 OpenAI 风格的 chat.completion.chunk SSE 流转成 Anthropic Messages SSE。
 * 输入/输出都是 utf-8 bytes；本函数不接受裸流（流式由调用方 buffer 完整 body 后调用）。
 */
export function transformOpenAISSEToAnthropicSSE(body: Buffer | Uint8Array): Buffer {
  const text = toBuffer(body).toString('utf8');
  const chunks: string[] = [];

  let msgId = createId('msg');
  let model = 'unknown';
  let outputTokens = 0;
  let inputTokens = 0;
  let sentMessageStart = false;
  let thinkingOpen = false;
  let textOpen = false;
  let nextBlockIndex = 0;
  let thinkingIndex: number | null = null;
  let textIndex: number | null = null;
  let stopReason = 'end_turn';
  let finalUsage: Record<string, unknown> | null = null;

  const emit = (event: string, data: Record<string, unknown>): void => {
    chunks.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') break;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }

    if (!sentMessageStart) {
      if (typeof obj.id === 'string' && obj.id && !obj.id.startsWith('chatcmpl-')) msgId = obj.id;
      if (typeof obj.model === 'string' && obj.model) model = obj.model;
      emit('message_start', {
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 1,
            server_tool_use: null,
          },
        },
      });
      sentMessageStart = true;
    }

    const choices = Array.isArray(obj.choices) ? (obj.choices as Array<Record<string, unknown>>) : [];
    for (const ch of choices) {
      const delta = (ch.delta as Record<string, unknown> | undefined) || {};
      const reasoningContent = delta.reasoning_content;
      if (typeof reasoningContent === 'string' && reasoningContent) {
        if (!thinkingOpen) {
          thinkingIndex = nextBlockIndex;
          nextBlockIndex += 1;
          emit('content_block_start', {
            type: 'content_block_start',
            index: thinkingIndex,
            content_block: { type: 'thinking', thinking: '' },
          });
          thinkingOpen = true;
        }
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: thinkingIndex,
          delta: { type: 'thinking_delta', thinking: reasoningContent },
        });
      }
      const content = delta.content;
      if (typeof content === 'string' && content) {
        if (thinkingOpen) {
          emit('content_block_stop', { type: 'content_block_stop', index: thinkingIndex });
          thinkingOpen = false;
        }
        if (!textOpen) {
          textIndex = nextBlockIndex;
          nextBlockIndex += 1;
          emit('content_block_start', {
            type: 'content_block_start',
            index: textIndex,
            content_block: { type: 'text', text: '' },
          });
          textOpen = true;
        }
        outputTokens += Math.max(1, Math.floor((content.length + 3) / 4));
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'text_delta', text: content },
        });
      }
      const finishReason = ch.finish_reason;
      if (typeof finishReason === 'string' && finishReason) {
        stopReason = mapFinishReason(finishReason) ?? 'end_turn';
      }
    }

    const usage = (obj.usage as Record<string, unknown> | undefined) || null;
    if (usage) {
      finalUsage = usage;
      const promptTokens = Number(usage.prompt_tokens);
      if (Number.isFinite(promptTokens)) inputTokens = Math.trunc(promptTokens);
      const completionTokens = Number(usage.completion_tokens);
      if (Number.isFinite(completionTokens)) outputTokens = Math.trunc(completionTokens);
    }
  }

  if (!sentMessageStart) {
    emit('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
          server_tool_use: null,
        },
      },
    });
  }
  if (thinkingOpen) {
    emit('content_block_stop', { type: 'content_block_stop', index: thinkingIndex });
  }
  if (textOpen) {
    emit('content_block_stop', { type: 'content_block_stop', index: textIndex });
  }
  const usageOut: Record<string, number | null> = { output_tokens: outputTokens };
  if (inputTokens || (finalUsage && Number.isFinite(Number(finalUsage.prompt_tokens)))) {
    usageOut.input_tokens = inputTokens || Math.trunc(Number(finalUsage?.prompt_tokens ?? 0));
  } else {
    usageOut.input_tokens = 0;
  }
  emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: usageOut,
  });
  emit('message_stop', { type: 'message_stop' });

  return Buffer.from(chunks.join(''), 'utf8');
}

/**
 * 把非流式 OpenAI chat.completion JSON 转成 Anthropic message JSON。
 * 输入解析失败时原样返回 bytes。
 */
export function transformOpenAIJsonToAnthropicJson(body: Buffer | Uint8Array): Buffer {
  const text = toBuffer(body).toString('utf8');
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(text) as Record<string, unknown>; } catch { return toBuffer(body); }
  const choices = Array.isArray(obj.choices) ? (obj.choices as Array<Record<string, unknown>>) : [];
  if (choices.length === 0) return toBuffer(body);

  const choice = choices[0] || {};
  const message = (choice.message as Record<string, unknown> | undefined) || {};
  const content: Array<Record<string, unknown>> = [];
  const reasoning = message.reasoning_content;
  if (typeof reasoning === 'string' && reasoning) {
    content.push({ type: 'thinking', thinking: reasoning });
  }
  const mainContent = message.content;
  if (typeof mainContent === 'string' && mainContent) {
    content.push({ type: 'text', text: mainContent });
  }

  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
  for (const toolCall of toolCalls) {
    const fn = (toolCall.function as Record<string, unknown> | undefined) || {};
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(String(fn.arguments ?? '{}')) as Record<string, unknown>;
    } catch {
      input = { raw: String(fn.arguments ?? '') };
    }
    content.push({
      type: 'tool_use',
      id: String(toolCall.id ?? ''),
      name: String(fn.name ?? ''),
      input,
    });
  }

  const usage = (obj.usage as Record<string, unknown> | undefined) || {};
  const inputTokens = toInt(usage.prompt_tokens);
  const outputTokens = toInt(usage.completion_tokens);

  const rawId = typeof obj.id === 'string' ? obj.id : '';
  const fixedId = rawId.startsWith('chatcmpl-') || !rawId ? createId('msg') : rawId;

  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop';
  const stopReason = mapFinishReason(finishReason) ?? 'end_turn';

  const out = {
    id: fixedId,
    type: 'message',
    role: 'assistant',
    model: typeof obj.model === 'string' ? obj.model : 'unknown',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: outputTokens || 1,
      server_tool_use: null,
    },
  };
  return Buffer.from(JSON.stringify(out), 'utf8');
}
