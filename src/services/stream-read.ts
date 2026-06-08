export class StreamClientAbortError extends Error {
  constructor() {
    super('client aborted stream');
    this.name = 'StreamClientAbortError';
  }
}

export async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  idleMessage: string,
  clientAbortSignal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (clientAbortSignal?.aborted) {
    throw new StreamClientAbortError();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;

  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(idleMessage)), idleTimeoutMs);
    if (clientAbortSignal) {
      // body 被 getReader() 锁定后，路由层无法 cancel；必须让 reader 持有者感知客户端断开。
      abortHandler = () => reject(new StreamClientAbortError());
      clientAbortSignal.addEventListener('abort', abortHandler, { once: true });
    }
  });

  try {
    return await Promise.race([reader.read(), guard]);
  } finally {
    if (timer) clearTimeout(timer);
    if (clientAbortSignal && abortHandler) {
      clientAbortSignal.removeEventListener('abort', abortHandler);
    }
  }
}
