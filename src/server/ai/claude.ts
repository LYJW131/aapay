import Anthropic from '@anthropic-ai/sdk';
import { ModelError, parseToolArgs, withIdleTimeout, type ModelKey, type ModelOptions, type ModelRequest, type Part } from './model.ts';

const MAX_TOKENS = 16000;

// 结构化输出的 schema 不支持 maxItems / minItems，对象必须写明 additionalProperties: false
function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'maxItems' || key === 'minItems') continue;
    out[key] = key === 'properties' ? Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, strictSchema(v)])) : strictSchema(value);
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

function blocks(parts: Part[]): Anthropic.ContentBlockParam[] {
  return parts.flatMap((p): Anthropic.ContentBlockParam[] => {
    if (p.result) return [{ type: 'tool_result', tool_use_id: p.result.id ?? '', content: JSON.stringify(p.result.response) }];
    if (p.image) return [{ type: 'image', source: { type: 'base64', media_type: p.image.mimeType as Anthropic.Base64ImageSource['media_type'], data: p.image.data } }];
    if (p.call) return [{ type: 'tool_use', id: p.call.id ?? '', name: p.call.name, input: p.call.args ?? {} }];
    if (p.thought && p.redacted) return [{ type: 'redacted_thinking', data: p.signature ?? '' }];
    if (p.thought) return [{ type: 'thinking', thinking: p.text ?? '', signature: p.signature ?? '' }];
    if (p.text) return [{ type: 'text', text: p.text }];
    return [];
  });
}

function toModelError(err: unknown) {
  if (err instanceof ModelError) return err;
  if (err instanceof Anthropic.APIError && err.status) return new ModelError(err.status, `Claude ${err.status}: ${err.message}`);
  return new ModelError(502, `Claude connection failed: ${String(err)}`);
}

const client = (apiKey: string) => new Anthropic({ apiKey, maxRetries: 1 });

interface OpenBlock {
  type: string;
  id?: string;
  name?: string;
  text: string;
  signature: string;
}

export async function* streamClaude(request: ModelRequest, options: ModelOptions): AsyncGenerator<Part[]> {
  const controller = new AbortController();
  const params: Anthropic.MessageCreateParamsStreaming = {
    model: options.model,
    max_tokens: MAX_TOKENS,
    stream: true,
    cache_control: { type: 'ephemeral' },
    system: request.system,
    messages: request.messages
      .map((m): Anthropic.MessageParam => ({ role: m.role === 'model' ? 'assistant' : 'user', content: blocks(m.parts) }))
      .filter((m) => m.content.length > 0),
    ...(request.tools?.length && {
      tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema, eager_input_streaming: true })),
      ...(request.toolChoice === 'none' && { tool_choice: { type: 'none' } }),
    }),
    ...(request.json && { output_config: { format: { type: 'json_schema', schema: strictSchema(request.json) as Record<string, unknown> } } }),
  };
  async function* events() {
    yield* await client(options.apiKey).messages.create(params, { signal: controller.signal });
  }
  const stream = withIdleTimeout('Claude', events(), {
    idleTimeout: options.idleTimeout,
    signal: options.signal,
    abort: () => controller.abort(),
    renews: () => true,
    mapError: toModelError,
  });

  const open = new Map<number, OpenBlock>();
  for await (const event of stream) {
    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block;
        open.set(event.index, {
          type: block.type,
          ...(block.type === 'tool_use' && { id: block.id, name: block.name }),
          text: '',
          signature: block.type === 'redacted_thinking' ? block.data : '',
        });
        break;
      }
      case 'content_block_delta': {
        const block = open.get(event.index);
        const delta = event.delta;
        if (delta.type === 'text_delta') yield [{ text: delta.text }];
        else if (!block) break;
        else if (delta.type === 'thinking_delta') block.text += delta.thinking;
        else if (delta.type === 'signature_delta') block.signature += delta.signature;
        else if (delta.type === 'input_json_delta') block.text += delta.partial_json;
        break;
      }
      case 'content_block_stop': {
        const block = open.get(event.index);
        open.delete(event.index);
        if (block?.type === 'thinking') yield [{ text: block.text, thought: true, signature: block.signature }];
        else if (block?.type === 'redacted_thinking') yield [{ thought: true, redacted: true, signature: block.signature }];
        else if (block?.type === 'tool_use') yield [{ call: { id: block.id, name: block.name!, args: parseToolArgs(block.text) } }];
        break;
      }
      case 'message_delta':
        if (event.delta.stop_reason === 'refusal') throw new ModelError(502, 'Claude declined the request');
        break;
    }
  }
}

export async function checkClaude({ apiKey, model, idleTimeout }: ModelKey) {
  try {
    await client(apiKey).models.retrieve(model, {}, { signal: AbortSignal.timeout(idleTimeout) });
  } catch (err) {
    if (err instanceof Anthropic.APIError && err.status) throw toModelError(err);
    throw new ModelError(err instanceof Error && /timed? ?out|abort/i.test(err.message + err.name) ? 504 : 502, `Claude unreachable: ${String(err)}`);
  }
}
