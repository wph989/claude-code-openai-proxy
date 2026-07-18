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
import { isPlainObject } from '../utils/guards.js';
import { SseEventDecoder, renderSseEvents, type SseEvent } from './response-fix/sse-codec.js';

// 保留旧导入路径作为兼容门面，调用方可逐步迁移到职责更窄的子模块。
export {
  looksLikeAnthropicSSE,
  looksLikeBrokenAnthropicSSE,
  looksLikeOpenAISSE,
} from './response-fix/detection.js';
export {
  transformOpenAIJsonToAnthropicJson,
  transformOpenAISSEToAnthropicSSE,
} from './response-fix/openai-converter.js';

export interface FixInfo {
  newId: string;
  droppedThinkingIndices: number[];
  renumbered: Record<number, number>;
  inserted: { contentBlockStop: number[]; messageDelta: boolean; messageStop: boolean };
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
  private decoder = new SseEventDecoder();
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
    const ready = this.decoder.push(chunk);
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
