import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pipeOpenAISse } from '../src/routes/chat-completions.js';
import { SseUsageTracker } from '../src/services/passthrough/sse-usage.js';

describe('SseUsageTracker', () => {
  it('在 OpenAI 事件的任意字节边界切分后仍能读取 usage', () => {
    const source = Buffer.from(
      'data: {"choices":[{"delta":{"content":"中文"}}],"usage":{"prompt_tokens":13,"completion_tokens":5}}\n\n' +
      'data: [DONE]\n\n',
      'utf8',
    );

    // 穷举两段式切分点，覆盖 JSON、换行及 UTF-8 多字节字符边界。
    for (let split = 0; split <= source.length; split += 1) {
      const tracker = new SseUsageTracker();
      tracker.push(source.subarray(0, split));
      tracker.push(source.subarray(split));
      expect(tracker.finish(), `split=${split}`).toEqual({
        inputTokens: 13,
        outputTokens: 5,
      });
    }
  });

  it('合并 Anthropic 分散的累计 usage，并处理 CRLF 和无末尾换行', () => {
    const source = Buffer.from(
      'event: message_start\r\n' +
      'data: {"message":{"usage":{"input_tokens":21,"output_tokens":0}}}\r\n\r\n' +
      'event: message_delta\r\n' +
      'data: {"usage":{"output_tokens":8}}',
      'utf8',
    );
    const tracker = new SseUsageTracker();

    // 单字节喂入模拟最极端的网络分块，确保状态不依赖 chunk 形状。
    for (let index = 0; index < source.length; index += 1) {
      tracker.push(source.subarray(index, index + 1));
    }

    expect(tracker.finish()).toEqual({ inputTokens: 21, outputTokens: 8 });
    expect(tracker.finish()).toEqual({ inputTokens: 21, outputTokens: 8 });
  });
});

describe('pipeOpenAISse usage', () => {
  it('保持上游字节不变，并在成功结束时上报 Token', async () => {
    const source = Buffer.from(
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n' +
      'data: [DONE]\n\n',
      'utf8',
    );
    const upstreamResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(source.subarray(0, 17));
        controller.enqueue(source.subarray(17));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await pipeOpenAISse({
      upstreamResponse,
      output,
      requestId: 'req-usage',
      sessionId: 'session-usage',
      providerId: 'provider-usage',
      clientModel: 'client-model',
      upstreamModel: 'upstream-model',
      idleTimeoutMs: 1000,
      onUsage: (value) => { usage = value; },
    });

    expect(Buffer.concat(chunks)).toEqual(source);
    expect(usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });
});
