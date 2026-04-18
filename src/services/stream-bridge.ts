import { PassThrough } from 'node:stream';
import { log } from '../utils/logger.js';
import { mapFinishReason } from './transformers.js';

interface StreamMetrics {
  requestId: string;
  sessionId: string;
  providerId: string;
  clientModel: string;
  upstreamModel: string;
}

interface ToolBlockState {
  anthropicIndex: number;
  toolId: string;
  toolName: string;
  partialJson: string;
  started: boolean;
  stopped: boolean;
}

interface StreamState {
  messageId: string;
  clientModel: string;
  textStarted: boolean;
  textStopped: boolean;
  textIndex: number;
  nextContentIndex: number;
  stopReason: string | null;
  usageInputTokens: number | null;
  usageOutputTokens: number | null;
  tools: Map<number, ToolBlockState>;
}

export async function bridgeOpenAIStreamToAnthropic(params: {
  upstreamResponse: Response;
  output: PassThrough;
  clientModel: string;
  messageId: string;
  metrics: StreamMetrics;
}): Promise<void> {
  const { upstreamResponse, output, clientModel, messageId, metrics } = params;
  const state: StreamState = {
    messageId,
    clientModel,
    textStarted: false,
    textStopped: false,
    textIndex: 0,
    nextContentIndex: 0,
    stopReason: null,
    usageInputTokens: null,
    usageOutputTokens: null,
    tools: new Map()
  };

  try {
    if (!upstreamResponse.ok) {
      const errorData = await upstreamResponse.text();
      writeSse(output, 'error', {
        type: 'error',
        error: {
          type: 'api_error',
          message: errorData || `上游请求失败，状态码=${upstreamResponse.status}`
        }
      });
      output.end();
      return;
    }

    writeSse(output, 'message_start', {
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        model: clientModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });

    for await (const event of iterateSse(upstreamResponse)) {
      if (event.data === '[DONE]') {
        break;
      }
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }

      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = (choices[0] || {}) as Record<string, unknown>;
      const delta = isPlainObject(choice.delta) ? choice.delta : {};
      const finishReason = choice.finish_reason;
      if (typeof finishReason === 'string' && finishReason) {
        state.stopReason = mapFinishReason(finishReason);
      }

      if (typeof delta.content === 'string' && delta.content) {
        if (!state.textStarted) {
          state.textStarted = true;
          state.textIndex = state.nextContentIndex;
          state.nextContentIndex += 1;
          writeSse(output, 'content_block_start', {
            type: 'content_block_start',
            index: state.textIndex,
            content_block: { type: 'text', text: '' }
          });
        }
        writeSse(output, 'content_block_delta', {
          type: 'content_block_delta',
          index: state.textIndex,
          delta: { type: 'text_delta', text: delta.content }
        });
      }

      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const rawToolDelta of toolCalls) {
        if (!isPlainObject(rawToolDelta)) continue;
        const index = Number(rawToolDelta.index ?? 0);
        const functionInfo = isPlainObject(rawToolDelta.function) ? rawToolDelta.function : {};
        let toolState = state.tools.get(index);
        if (!toolState) {
          toolState = {
            anthropicIndex: state.nextContentIndex,
            toolId: '',
            toolName: '',
            partialJson: '',
            started: false,
            stopped: false
          };
          state.tools.set(index, toolState);
          state.nextContentIndex += 1;
        }

        if (typeof rawToolDelta.id === 'string' && rawToolDelta.id) {
          toolState.toolId = rawToolDelta.id;
        }
        if (typeof functionInfo.name === 'string' && functionInfo.name) {
          toolState.toolName = functionInfo.name;
        }
        if (!toolState.started) {
          toolState.started = true;
          writeSse(output, 'content_block_start', {
            type: 'content_block_start',
            index: toolState.anthropicIndex,
            content_block: {
              type: 'tool_use',
              id: toolState.toolId,
              name: toolState.toolName,
              input: {}
            }
          });
        }
        if (typeof functionInfo.arguments === 'string' && functionInfo.arguments) {
          toolState.partialJson += functionInfo.arguments;
          writeSse(output, 'content_block_delta', {
            type: 'content_block_delta',
            index: toolState.anthropicIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: functionInfo.arguments
            }
          });
        }
      }

      const usage = isPlainObject(chunk.usage) ? chunk.usage : {};
      if (usage.prompt_tokens != null) {
        state.usageInputTokens = toInt(usage.prompt_tokens);
      }
      if (usage.completion_tokens != null) {
        state.usageOutputTokens = toInt(usage.completion_tokens);
      }
    }

    if (state.textStarted && !state.textStopped) {
      state.textStopped = true;
      writeSse(output, 'content_block_stop', { type: 'content_block_stop', index: state.textIndex });
    }
    for (const [, toolState] of Array.from(state.tools.entries()).sort((a, b) => a[0] - b[0])) {
      if (!toolState.stopped) {
        toolState.stopped = true;
        writeSse(output, 'content_block_stop', { type: 'content_block_stop', index: toolState.anthropicIndex });
      }
    }

    writeSse(output, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: state.stopReason, stop_sequence: null },
      usage: {
        input_tokens: state.usageInputTokens ?? 0,
        output_tokens: state.usageOutputTokens ?? 0
      }
    });
    writeSse(output, 'message_stop', { type: 'message_stop' });

    log('info', '流式响应完成', {
      request_id: metrics.requestId,
      session_id: metrics.sessionId,
      provider_id: metrics.providerId,
      client_model: metrics.clientModel,
      upstream_model: metrics.upstreamModel,
      input_tokens: state.usageInputTokens,
      output_tokens: state.usageOutputTokens,
      stop_reason: state.stopReason
    });
  } catch (error) {
    log('error', '流式桥接失败', {
      request_id: metrics.requestId,
      session_id: metrics.sessionId,
      provider_id: metrics.providerId,
      client_model: metrics.clientModel,
      upstream_model: metrics.upstreamModel,
      error
    });
    writeSse(output, 'error', {
      type: 'error',
      error: {
        type: 'api_error',
        message: '流式桥接失败。'
      }
    });
  } finally {
    output.end();
  }
}

function writeSse(output: PassThrough, event: string, data: Record<string, unknown>): void {
  output.write(`event: ${event}\n`);
  output.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function* iterateSse(response: Response): AsyncGenerator<{ event?: string; data: string }> {
  const body = response.body;
  if (!body) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | undefined;
  let dataLines: string[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const line = rawLine.replace(/\r$/, '');

      if (line === '') {
        if (dataLines.length > 0) {
          yield { event: currentEvent, data: dataLines.join('\n') };
        }
        currentEvent = undefined;
        dataLines = [];
      } else if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }

      newlineIndex = buffer.indexOf('\n');
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const line = buffer.replace(/\r$/, '');
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length > 0) {
    yield { event: currentEvent, data: dataLines.join('\n') };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toInt(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}
