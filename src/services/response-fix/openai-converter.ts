import { createId } from '../../utils/id.js';
import { toInt } from '../../utils/guards.js';
import { mapFinishReason } from '../transformers.js';
import { toBuffer } from './bytes.js';

/**
 * 把 OpenAI 风格的 chat.completion.chunk SSE 流转成 Anthropic Messages SSE。
 * 输入/输出都是 UTF-8 bytes；裸流由上层在完整响应边界调用。
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
    for (const choice of choices) {
      const delta = (choice.delta as Record<string, unknown> | undefined) || {};
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
      const finishReason = choice.finish_reason;
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

/** 把非流式 OpenAI chat.completion JSON 转成 Anthropic message JSON。 */
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
