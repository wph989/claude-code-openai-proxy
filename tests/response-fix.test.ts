import { describe, it, expect } from 'vitest';
import {
  looksLikeOpenAISSE,
  looksLikeBrokenAnthropicSSE,
  StreamingAnthropicSSEFixer,
  transformOpenAISSEToAnthropicSSE,
  transformOpenAIJsonToAnthropicJson,
} from '../src/services/response-fix.js';

describe('looksLikeOpenAISSE', () => {
  it('detects chat.completion.chunk marker', () => {
    const body = Buffer.from(
      'data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[]}\n\n'
    );
    expect(looksLikeOpenAISSE(body)).toBe(true);
  });

  it('detects the spaced variant of the object marker', () => {
    const body = Buffer.from('data: {"id":"chatcmpl-abc", "object": "chat.completion.chunk"}\n\n');
    expect(looksLikeOpenAISSE(body)).toBe(true);
  });

  it('returns false for an Anthropic message_start', () => {
    const body = Buffer.from(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_abc"}}\n\n'
    );
    expect(looksLikeOpenAISSE(body)).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(looksLikeOpenAISSE(Buffer.alloc(0))).toBe(false);
  });
});

describe('looksLikeBrokenAnthropicSSE', () => {
  it('detects anthropic frame with chatcmpl- id', () => {
    const body = Buffer.from(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"chatcmpl-leak"}}\n\n'
    );
    expect(looksLikeBrokenAnthropicSSE(body)).toBe(true);
  });

  it('returns false when the id is already a msg_ token', () => {
    const body = Buffer.from(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok"}}\n\n'
    );
    expect(looksLikeBrokenAnthropicSSE(body)).toBe(false);
  });

  it('returns false for pure OpenAI SSE', () => {
    const body = Buffer.from('data: {"id":"chatcmpl-x","object":"chat.completion.chunk"}\n\n');
    expect(looksLikeBrokenAnthropicSSE(body)).toBe(false);
  });
});

function makeBrokenSample(includeCloseEvents: boolean): Buffer {
  const closeEvents = includeCloseEvents
    ? Buffer.from(
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":7}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      )
    : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from(
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"type":"message","model":"deepseek-v4-pro",' +
      '"usage":{"input_tokens":100,"output_tokens":0},"role":"assistant",' +
      '"id":"chatcmpl-deadbeefcafe","content":[]}}\n\n'
    ),
    Buffer.from(
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":5,"content_block":{"type":"thinking"}}\n\n'
    ),
    Buffer.from(
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":5,"delta":{"type":"thinking_delta",' +
      '"thinking":"user said hi"}}\n\n'
    ),
    Buffer.from(
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":5}\n\n'
    ),
    Buffer.from(
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":7,"content_block":{"type":"text","text":""}}\n\n'
    ),
    Buffer.from(
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":7,"delta":{"type":"text_delta","text":"hi"}}\n\n'
    ),
    closeEvents,
  ]);
}

describe('StreamingAnthropicSSEFixer', () => {
  it('rewrites chatcmpl- ids, drops thinking, renumbers blocks, and fills usage', () => {
    const input = makeBrokenSample(true);
    const fixer = new StreamingAnthropicSSEFixer({ dropThinking: true, newId: 'msg_test123' });
    const chunk = fixer.push(input);
    const tail = fixer.finalize();
    const fixed = Buffer.concat([chunk ?? Buffer.from(''), tail]);
    const text = fixed.toString('utf8');
    const info = fixer.getFixInfo();

    expect(text.includes('chatcmpl-')).toBe(false);
    expect(text.includes('msg_test123')).toBe(true);
    expect(info.newId).toBe('msg_test123');
    expect(text.includes('thinking')).toBe(false);
    expect(text.includes('cache_creation_input_tokens')).toBe(true);
    expect(text.includes('cache_read_input_tokens')).toBe(true);
    expect(text.includes('server_tool_use')).toBe(true);

    // content_block_start 应该按出现顺序重新编号：原 index 5 丢弃后只剩 index 7 的 text 块 -> 0
    expect(text.includes('"index":0,"content_block":{"type":"text"')).toBe(true);
    expect(info.renumbered).toEqual({ 7: 0 });
    expect(info.droppedThinkingIndices).toEqual([5]);
  });

  it('appends missing content_block_stop / message_delta / message_stop', () => {
    const input = makeBrokenSample(false);
    const fixer = new StreamingAnthropicSSEFixer({ dropThinking: true });
    const chunk = fixer.push(input);
    const tail = fixer.finalize();
    const fixed = Buffer.concat([chunk ?? Buffer.from(''), tail]);
    const text = fixed.toString('utf8');
    const info = fixer.getFixInfo();

    expect(text.includes('event: content_block_stop')).toBe(true);
    expect(text.includes('event: message_delta')).toBe(true);
    expect(text.includes('event: message_stop')).toBe(true);
    expect(info.inserted.messageDelta).toBe(true);
    expect(info.inserted.messageStop).toBe(true);
    expect(info.inserted.contentBlockStop.length).toBeGreaterThan(0);
  });

  it('does not double-insert close events that already exist', () => {
    const input = makeBrokenSample(true);
    const fixer = new StreamingAnthropicSSEFixer({ dropThinking: true });
    const chunk = fixer.push(input);
    const tail = fixer.finalize();
    const fixed = Buffer.concat([chunk ?? Buffer.from(''), tail]);
    const occurrences = (fixed.toString('utf8').match(/event: content_block_stop/g) || []).length;
    const info = fixer.getFixInfo();
    // 原样本里 1 个 stop（thinking 块被丢弃后剩 1 个 text 块的 stop）+ 修复后 0 个补 = 1
    expect(occurrences).toBe(1);
    expect(info.inserted.contentBlockStop).toEqual([]);
    expect(info.inserted.messageDelta).toBe(false);
    expect(info.inserted.messageStop).toBe(false);
  });

  it('emits no tail bytes when the Anthropic stream already has all close events', () => {
    const input = makeBrokenSample(true);
    const fixer = new StreamingAnthropicSSEFixer({ dropThinking: true });
    fixer.push(input);

    expect(fixer.finalize().length).toBe(0);
  });

  it('handles chunked input split at event boundaries', () => {
    const part1 = Buffer.from('event: message_start\ndata: {"type":"mes');
    const part2 = Buffer.from('sage_start","message":{"id":"chatcmpl-split"}}\n\n');
    const part3 = Buffer.from('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');

    const fixer = new StreamingAnthropicSSEFixer({ newId: 'msg_chunked' });
    const out1 = fixer.push(part1); // 不完整事件，应返回 null
    const out2 = fixer.push(part2); // 完成 message_start
    const out3 = fixer.push(part3); // content_block_start
    const tail = fixer.finalize();

    const full = Buffer.concat([
      out1 ?? Buffer.from(''),
      out2 ?? Buffer.from(''),
      out3 ?? Buffer.from(''),
      tail
    ]).toString('utf8');

    expect(full.includes('msg_chunked')).toBe(true);
    expect(full.includes('message_start')).toBe(true);
    expect(full.includes('content_block_start')).toBe(true);
    expect(full.includes('chatcmpl-')).toBe(false);
  });

  it('terminates every streamed event with a blank line when chunks are emitted separately', () => {
    const events = [
      Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"id":"chatcmpl-sep","role":"assistant","content":[]}}\n\n'),
      Buffer.from('event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n'),
      Buffer.from('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}\n\n'),
    ];
    const fixer = new StreamingAnthropicSSEFixer({ newId: 'msg_sep' });
    const fixed = Buffer.concat(events.map((event) => fixer.push(event) ?? Buffer.from('')));
    const text = fixed.toString('utf8');

    // Claude Code 按空行派发 SSE 事件；逐事件 write 时缺这个分隔符会导致客户端一直攒包不显示。
    expect(text).toContain('\n\nevent: content_block_start');
    expect(text).toContain('\n\nevent: content_block_delta');
    expect(text.endsWith('\n\n')).toBe(true);
  });

  it('repairs frames that only identify the event through data.type', () => {
    const input = Buffer.from(
      'data: {"type":"message_start","message":{"id":"chatcmpl-no-event","role":"assistant","content":[]}}\n\n' +
      'data: {"type":"content_block_start","index":4,"content_block":{"type":"text","text":""}}\n\n' +
      'data: {"type":"content_block_delta","index":4,"delta":{"type":"text_delta","text":"hi"}}\n\n'
    );
    const fixer = new StreamingAnthropicSSEFixer({ newId: 'msg_noevent' });
    const chunk = fixer.push(input);
    const tail = fixer.finalize();
    const text = Buffer.concat([chunk ?? Buffer.from(''), tail]).toString('utf8');

    expect(text).toContain('event: message_start');
    expect(text).toContain('msg_noevent');
    expect(text).toContain('"index":0');
    expect(text).toContain('event: content_block_stop');
    expect(text).toContain('event: message_stop');
    expect(text).not.toContain('chatcmpl-no-event');
  });

  it('converts thinking blocks to text when dropThinking=false', () => {
    const input = Buffer.from(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n'
    );
    const fixer = new StreamingAnthropicSSEFixer({ dropThinking: false });
    const chunk = fixer.push(input);
    const text = (chunk ?? Buffer.from('')).toString('utf8');

    expect(text.includes('"type":"text"')).toBe(true);
    expect(text.includes('"type":"text_delta"')).toBe(true);
    expect(text.includes('"text":"hmm"')).toBe(true);
    expect(text.includes('thinking')).toBe(false);
  });

  it('drops malformed content block deltas that would expose undefined text fields to Claude Code', () => {
    const input = Buffer.from(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-ok","role":"assistant","content":[]}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'
    );
    const fixer = new StreamingAnthropicSSEFixer();
    const fixed = fixer.push(input)?.toString('utf8') ?? '';

    expect(fixed).not.toContain('"delta":{"type":"text_delta"}');
    expect(fixed).toContain('"delta":{"type":"text_delta","text":"ok"}');
  });
});

describe('transformOpenAISSEToAnthropicSSE', () => {
  it('produces a message_start with the full five-field usage block', () => {
    const input = Buffer.from(
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-x","choices":[]}\n\n' +
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n' +
      'data: [DONE]\n\n'
    );
    const out = transformOpenAISSEToAnthropicSSE(input).toString('utf8');
    expect(out.includes('event: message_start')).toBe(true);
    expect(out.includes('cache_creation_input_tokens')).toBe(true);
    expect(out.includes('cache_read_input_tokens')).toBe(true);
    expect(out.includes('server_tool_use')).toBe(true);
    expect(out.includes('event: content_block_delta')).toBe(true);
    expect(out.includes('event: message_delta')).toBe(true);
    expect(out.includes('event: message_stop')).toBe(true);
    expect(out.includes('"output_tokens":2')).toBe(true);
  });

  it('emits an empty message_start when upstream returns no chunks', () => {
    const input = Buffer.from('');
    const out = transformOpenAISSEToAnthropicSSE(input).toString('utf8');
    expect(out.includes('event: message_start')).toBe(true);
    expect(out.includes('event: message_stop')).toBe(true);
  });

  it('maps finish_reason stop to end_turn and tool_calls to tool_use', () => {
    const input = Buffer.from(
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\n' +
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n'
    );
    const out = transformOpenAISSEToAnthropicSSE(input).toString('utf8');
    expect(out.includes('"stop_reason":"tool_use"')).toBe(true);
  });
});

describe('transformOpenAIJsonToAnthropicJson', () => {
  it('replaces chatcmpl- id and emits a complete Anthropic body', () => {
    const input = Buffer.from(JSON.stringify({
      id: 'chatcmpl-xyz',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hello' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }
    }));
    const out = JSON.parse(transformOpenAIJsonToAnthropicJson(input).toString('utf8'));
    expect(out.id.startsWith('msg_')).toBe(true);
    expect(out.type).toBe('message');
    expect(out.role).toBe('assistant');
    expect(out.stop_reason).toBe('end_turn');
    expect(out.usage.input_tokens).toBe(9);
    expect(out.usage.output_tokens).toBe(3);
    expect(out.usage.cache_creation_input_tokens).toBe(0);
    expect(out.usage.cache_read_input_tokens).toBe(0);
    expect(out.usage.server_tool_use).toBeNull();
    expect(Array.isArray(out.content)).toBe(true);
    expect(out.content[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('translates tool_calls to tool_use content blocks', () => {
    const input = Buffer.from(JSON.stringify({
      id: 'chatcmpl-xyz',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }));
    const out = JSON.parse(transformOpenAIJsonToAnthropicJson(input).toString('utf8'));
    expect(out.content[0].type).toBe('tool_use');
    expect(out.content[0].id).toBe('call_1');
    expect(out.stop_reason).toBe('tool_use');
  });

  it('returns the original bytes on JSON parse failure', () => {
    const input = Buffer.from('not json at all');
    const out = transformOpenAIJsonToAnthropicJson(input);
    expect(out.toString('utf8')).toBe('not json at all');
  });
});
