/**
 * peek + restore：从一个未消费的 Response 中"试读"前 N 字节，再把已读片段拼回 stream，
 * 让下游可以继续读到完整 body。
 *
 * 用途：在选择"用哪种 SSE 修复管线"之前需要先 peek 头部识别协议形态（OpenAI / Anthropic）；
 *      reader 一旦 read 过就回不去了，所以要把已读 chunks + 剩余 reader 重组成一个新的 Response。
 */

import { readStreamChunk } from '../stream-read.js';

export interface PeekResult {
  /** 已读到的头部字节（最多 bytes 长度，可能更短）。 */
  peek: Buffer;
  /** 把"已读 + 未读"重组后的 Response，下游应继续在这个对象上读。 */
  restored: Response;
  /** peek 阶段如果上游已断流，记录错误信息让修复器写收尾日志。 */
  peekError?: string;
}

/**
 * 上游在 peek 阶段已经断流时，仍要把已读到的 Anthropic 头部交给修复器，
 * 让它补齐 message_stop；否则客户端只能看到一个代理 error 事件。
 */
export async function peekAndRestore(
  response: Response,
  bytes: number,
  idleTimeoutMs: number,
  abortSignal?: AbortSignal
): Promise<PeekResult> {
  if (!response.body) return { peek: Buffer.alloc(0), restored: response };
  const reader = response.body.getReader();
  const head: Uint8Array[] = [];
  let total = 0;
  let peekError: string | undefined;

  try {
    while (total < bytes) {
      const { value, done } = await readStreamChunk(reader, idleTimeoutMs, `SSE peek timeout after ${idleTimeoutMs}ms`, abortSignal);
      if (done) break;
      head.push(value);
      total += value.length;
      if (total >= bytes) break;
    }
  } catch (error) {
    peekError = error instanceof Error ? error.message : String(error);
    // peek 失败时保留已读片段，后续管道会负责释放 lease 和结束响应。
  }

  const peek = Buffer.concat(head.map((chunk) => Buffer.from(chunk)));
  if (peek.length === 0) return { peek, restored: response, peekError };

  const combined = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const chunk of head) controller.enqueue(chunk);
        if (peekError) {
          controller.close();
          return;
        }
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return {
    peek,
    peekError,
    restored: new Response(combined, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}
