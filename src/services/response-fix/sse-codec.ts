import { toBuffer } from './bytes.js';

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * 只负责把任意 chunk 边界还原成完整 SSE 事件。
 * 协议修复状态放在上层，避免解析器和 Anthropic 业务规则互相耦合。
 */
export class SseEventDecoder {
  private buffer = '';
  private current: SseEvent = { data: '' };

  push(chunk: Buffer | Uint8Array | string): SseEvent[] {
    this.buffer += toBuffer(chunk).toString('utf8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const ready: SseEvent[] = [];
    const flush = () => {
      if (this.current.data || this.current.event) {
        ready.push({ event: this.current.event, data: this.current.data });
        this.current = { data: '' };
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
    return ready;
  }
}

/** 每条事件以 event/data 双行和空行结束，确保分次 write 时客户端会及时派发。 */
export function renderSseEvents(events: SseEvent[]): Buffer {
  if (events.length === 0) return Buffer.from('');
  const lines: string[] = [];
  for (const event of events) {
    lines.push(`event: ${event.event ?? 'message'}`);
    lines.push(`data: ${event.data ?? '{}'}`);
    lines.push('');
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}
