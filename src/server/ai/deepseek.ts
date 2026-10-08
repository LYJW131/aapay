import { ModelError, parseData, probe, sseStream, type ModelKey, type ModelOptions, type ModelRequest, type Part, type ToolCall } from './model.ts';

const BASE = 'https://api.deepseek.com';

interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface DeepSeekChunk {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }[];
  error?: { code?: number | string; message?: string };
}

const FAILED_FINISH: Record<string, number> = { content_filter: 502, insufficient_system_resource: 503 };

function messages(request: ModelRequest) {
  const system = request.json
    ? `${request.system}\n\nRespond with only a json object that matches this JSON Schema:\n${JSON.stringify(request.json)}`
    : request.system;
  const out: object[] = [{ role: 'system', content: system }];
  for (const m of request.messages) {
    if (m.role === 'model') {
      const text = m.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
      const reasoning = m.parts.filter((p) => p.text && p.thought).map((p) => p.text).join('');
      const calls = m.parts.flatMap((p) => (p.call ? [{ id: p.call.id, type: 'function', function: { name: p.call.name, arguments: JSON.stringify(p.call.args ?? {}) } }] : []));
      // 思考模式下带工具调用的 assistant 消息缺 reasoning_content 字段会被拒（400），空字符串可以
      out.push({ role: 'assistant', content: text, reasoning_content: reasoning, ...(calls.length && { tool_calls: calls }) });
      continue;
    }
    for (const p of m.parts) if (p.result) out.push({ role: 'tool', tool_call_id: p.result.id, content: JSON.stringify(p.result.response) });
    const rest = m.parts.filter((p) => !p.result && (p.image || p.text !== undefined));
    if (!rest.length) continue;
    out.push({
      role: 'user',
      content: rest.some((p) => p.image)
        ? rest.map((p) => (p.image ? { type: 'image_url', image_url: { url: `data:${p.image.mimeType};base64,${p.image.data}` } } : { type: 'text', text: p.text }))
        : rest.map((p) => p.text).join('\n'),
    });
  }
  return out;
}

function parseArgs(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

class ToolCalls {
  private readonly open = new Map<number, { id?: string; name: string; args: string }>();
  private readonly closed = new Set<number>();

  add(pieces: ToolCallDelta[]) {
    for (const piece of pieces) {
      if (this.closed.has(piece.index)) {
        if (piece.function?.arguments?.trim()) throw new ModelError(502, `DeepSeek streamed tool call ${piece.index} after it looked complete`);
        continue;
      }
      const call = this.open.get(piece.index) ?? { name: '', args: '' };
      if (piece.id) call.id = piece.id;
      if (piece.function?.name) call.name = piece.function.name;
      if (piece.function?.arguments) call.args += piece.function.arguments;
      this.open.set(piece.index, call);
    }
  }

  // 后面的调用开始时，前面参数已是完整 JSON 的调用先放行，卡片能逐张出现；参数还不完整（交错到达）就等到结束
  *ready(): Generator<Part[]> {
    const indexes = [...this.open.keys()].sort((a, b) => a - b);
    for (const index of indexes.slice(0, -1)) {
      const call = this.open.get(index)!;
      const args = parseArgs(call.args);
      if (!args || !call.args.trim()) break;
      yield [{ call: this.close(index, args) }];
    }
  }

  *flush(): Generator<Part[]> {
    for (const index of [...this.open.keys()].sort((a, b) => a - b)) yield [{ call: this.close(index, parseArgs(this.open.get(index)!.args)) }];
  }

  private close(index: number, args: Record<string, unknown> | null): ToolCall {
    const call = this.open.get(index)!;
    this.open.delete(index);
    this.closed.add(index);
    return { id: call.id || `call_${index}`, name: call.name, args };
  }
}

export async function* streamDeepSeek(request: ModelRequest, options: ModelOptions): AsyncGenerator<Part[]> {
  const body = {
    model: options.model,
    messages: messages(request),
    stream: true,
    thinking: { type: 'enabled' },
    ...(request.tools?.length && {
      tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      ...(request.toolChoice === 'none' && { tool_choice: 'none' }),
    }),
    ...(request.json && { response_format: { type: 'json_object' } }),
    ...(request.temperature !== undefined && { temperature: request.temperature }),
  };
  const stream = sseStream(
    'DeepSeek',
    `${BASE}/chat/completions`,
    { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` }, body: JSON.stringify(body) },
    options,
  );
  const calls = new ToolCalls();
  let finished = false;
  for await (const data of stream) {
    if (data === '[DONE]') {
      finished = true;
      break;
    }
    const chunk = parseData<DeepSeekChunk>('DeepSeek', data);
    if (chunk.error) throw new ModelError(typeof chunk.error.code === 'number' ? chunk.error.code : 502, chunk.error.message ?? 'DeepSeek stream error');
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (delta.reasoning_content) yield [{ text: delta.reasoning_content, thought: true }];
    if (delta.content) yield [{ text: delta.content }];
    if (delta.tool_calls?.length) {
      calls.add(delta.tool_calls);
      yield* calls.ready();
    }
    if (choice.finish_reason) {
      const failed = FAILED_FINISH[choice.finish_reason];
      if (failed) throw new ModelError(failed, `DeepSeek finished with ${choice.finish_reason}`);
      finished = true;
      yield* calls.flush();
    }
  }
  if (!finished) throw new ModelError(502, 'DeepSeek stream ended before it finished');
}

export async function checkDeepSeek({ apiKey, model, idleTimeout }: ModelKey) {
  await probe('DeepSeek', `${BASE}/chat/completions`, idleTimeout, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, thinking: { type: 'disabled' } }),
  });
}
