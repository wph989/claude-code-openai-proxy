/**
 * 协议转换：Anthropic Messages <-> OpenAI Compatible Chat Completions
 */

export function anthropicContentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content ?? '');
  }

  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    const type = item.type;
    if (type === 'text') {
      texts.push(String(item.text ?? ''));
    } else if (type === 'tool_result') {
      const rawContent = item.content;
      if (Array.isArray(rawContent)) {
        const inner = rawContent
          .filter((part) => part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text')
          .map((part) => String((part as Record<string, unknown>).text ?? ''));
        texts.push(inner.join('\n'));
      } else {
        texts.push(String(rawContent ?? ''));
      }
    }
  }
  return texts.filter(Boolean).join('\n');
}

export function anthropicToOpenAIMessages(system: unknown, messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];

  if (system) {
    let systemText = '';
    if (typeof system === 'string') {
      systemText = system;
    } else if (Array.isArray(system)) {
      systemText = system
        .filter((block) => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text')
        .map((block) => String((block as Record<string, unknown>).text ?? ''))
        .join('\n');
    }
    if (systemText.trim()) {
      output.push({ role: 'system', content: systemText });
    }
  }

  for (const message of messages) {
    const role = String(message.role || 'user');
    const content = message.content;

    if (role === 'assistant' && Array.isArray(content)) {
      const textChunks: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const item = block as Record<string, unknown>;
        if (item.type === 'text') {
          textChunks.push(String(item.text ?? ''));
        } else if (item.type === 'tool_use') {
          toolCalls.push({
            id: String(item.id ?? ''),
            type: 'function',
            function: {
              name: String(item.name ?? ''),
              arguments: JSON.stringify(item.input ?? {}, null, 0)
            }
          });
        }
      }
      const assistant: Record<string, unknown> = { role: 'assistant' };
      if (textChunks.length > 0) {
        assistant.content = textChunks.join('\n');
      }
      if (toolCalls.length > 0) {
        assistant.tool_calls = toolCalls;
      }
      output.push(assistant);
      continue;
    }

    if (role === 'user' && Array.isArray(content)) {
      const toolResults = content.filter((block) => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_result');
      const normalBlocks = content.filter((block) => !(block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_result'));

      for (const toolResult of toolResults) {
        const item = toolResult as Record<string, unknown>;
        let toolContent = item.content;
        if (Array.isArray(toolContent)) {
          toolContent = toolContent
            .filter((part) => part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text')
            .map((part) => String((part as Record<string, unknown>).text ?? ''))
            .join('\n');
        }
        output.push({
          role: 'tool',
          tool_call_id: String(item.tool_use_id ?? ''),
          content: String(toolContent ?? '')
        });
      }

      if (normalBlocks.length > 0) {
        output.push({
          role: 'user',
          content: anthropicContentToText(normalBlocks)
        });
      }
      continue;
    }

    output.push({
      role,
      content: anthropicContentToText(content)
    });
  }

  return output;
}

export function anthropicToolsToOpenAI(tools?: Array<Record<string, unknown>> | null): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: String(tool.name ?? ''),
      description: String(tool.description ?? ''),
      parameters: (tool.input_schema as Record<string, unknown>) || { type: 'object', properties: {} }
    }
  }));
}

export function mapFinishReason(reason?: string | null): string | null {
  if (!reason) return null;
  if (reason === 'stop') return 'end_turn';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls') return 'tool_use';
  return reason;
}

export function openAIToAnthropicResponse(originalModel: string, data: Record<string, unknown>): {
  body: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
} {
  const choice = Array.isArray(data.choices) ? (data.choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = (choice?.message as Record<string, unknown> | undefined) || {};
  const contentBlocks: Array<Record<string, unknown>> = [];

  if (typeof message.content === 'string' && message.content) {
    contentBlocks.push({ type: 'text', text: message.content });
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
    contentBlocks.push({
      type: 'tool_use',
      id: String(toolCall.id ?? ''),
      name: String(fn.name ?? ''),
      input
    });
  }

  const usage = (data.usage as Record<string, unknown> | undefined) || {};
  const inputTokens = toInt(usage.prompt_tokens);
  const outputTokens = toInt(usage.completion_tokens);

  return {
    body: {
      id: String(data.id ?? ''),
      type: 'message',
      role: 'assistant',
      model: originalModel,
      content: contentBlocks,
      stop_reason: mapFinishReason(String(choice?.finish_reason ?? '')),
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens
      }
    },
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  };
}

function toInt(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}
