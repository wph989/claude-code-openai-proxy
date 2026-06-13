import { describe, it, expect } from 'vitest';
import { mapFinishReason, openAIToAnthropicResponse } from '../src/services/transformers.js';

describe('mapFinishReason', () => {
  it('maps all five OpenAI finish reasons to Anthropic', () => {
    expect(mapFinishReason('stop')).toBe('end_turn');
    expect(mapFinishReason('length')).toBe('max_tokens');
    expect(mapFinishReason('tool_calls')).toBe('tool_use');
    expect(mapFinishReason('function_call')).toBe('tool_use');
    expect(mapFinishReason('content_filter')).toBe('refusal');
  });

  it('returns null for empty input', () => {
    expect(mapFinishReason(null)).toBeNull();
    expect(mapFinishReason(undefined)).toBeNull();
    expect(mapFinishReason('')).toBeNull();
  });

  it('passes through unknown reasons', () => {
    expect(mapFinishReason('synthetic_reason')).toBe('synthetic_reason');
  });
});

describe('openAIToAnthropicResponse', () => {
  it('emits the full five-field usage block Anthropic clients require', () => {
    const { body } = openAIToAnthropicResponse('claude-3-5-sonnet', {
      id: 'chatcmpl-abc',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
    });
    const usage = body.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(12);
    expect(usage.output_tokens).toBe(4);
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.server_tool_use).toBeNull();
  });

  it('replaces chatcmpl- ids with msg_ prefix to satisfy Claude Code', () => {
    const { body } = openAIToAnthropicResponse('claude-3-5-sonnet', {
      id: 'chatcmpl-deadbeefcafe',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    });
    expect(typeof body.id).toBe('string');
    expect((body.id as string).startsWith('msg_')).toBe(true);
    expect((body.id as string).includes('chatcmpl-')).toBe(false);
  });

  it('keeps already-prefixed Anthropic-style ids untouched', () => {
    const { body } = openAIToAnthropicResponse('claude-3-5-sonnet', {
      id: 'msg_already_anthropic',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    });
    expect(body.id).toBe('msg_already_anthropic');
  });

  it('falls back to a fresh msg_ id when the upstream id is empty', () => {
    const { body } = openAIToAnthropicResponse('claude-3-5-sonnet', {
      id: '',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    });
    expect((body.id as string).startsWith('msg_')).toBe(true);
  });

  it('forces output_tokens to at least 1 because Anthropic clients reject 0', () => {
    const { body } = openAIToAnthropicResponse('claude-3-5-sonnet', {
      id: 'chatcmpl-abc',
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 0 }
    });
    expect((body.usage as Record<string, number>).output_tokens).toBe(1);
  });

  it('maps finish_reason end-to-end', () => {
    const cases: Array<[string, string]> = [
      ['stop', 'end_turn'],
      ['length', 'max_tokens'],
      ['tool_calls', 'tool_use'],
      ['function_call', 'tool_use'],
      ['content_filter', 'refusal']
    ];
    for (const [openaiReason, anthropicReason] of cases) {
      const { body } = openAIToAnthropicResponse('m', {
        id: 'chatcmpl-abc',
        choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: openaiReason }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      });
      expect(body.stop_reason).toBe(anthropicReason);
    }
  });

  it('translates tool_calls into Anthropic tool_use content blocks', () => {
    const { body } = openAIToAnthropicResponse('m', {
      id: 'chatcmpl-abc',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"sf"}' }
          }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    });
    const content = body.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('tool_use');
    expect(content[0].id).toBe('call_1');
    expect(content[0].name).toBe('get_weather');
    expect(content[0].input).toEqual({ city: 'sf' });
  });
});
