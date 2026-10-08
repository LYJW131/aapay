import { ModelError, parseData, parseToolArgs, probe, sseStream, type ModelKey, type ModelOptions, type ModelRequest, type Part, type ToolCall } from './model.ts';

interface Flavor {
  name: string;
  base: (key: ModelKey) => string;
  // DeepSeek 思考模式：显式开启思考，带工具调用的 assistant 消息必须带 reasoning_content（空字符串也行），否则 400
  deepseek: boolean;
}

const DEEPSEEK: Flavor = { name: 'DeepSeek', base: () => 'https://api.deepseek.com', deepseek: true };
const OPENAI: Flavor = { name: 'OpenAI-compatible', base: (key) => key.baseUrl!, deepseek: false };

interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatChunk {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }[];
  error?: { code?: number | string; message?: string };
}

const FAILED_FINISH: Record<string, number> = { content_filter: 502, insufficient_system_resource: 503 };

function messages(request: ModelRequest, flavor: Flavor) {
  const system = request.json
    ? `${request.system}\n\nRespond with only a json object that matches this JSON Schema:\n${JSON.stringify(request.json)}`
    : request.system;
  const out: object[] = [{ role: 'system', content: system }];
  for (const m of request.messages) {
    if (m.role === 'model') {
      const text = m.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
      const reasoning = m.parts.filter((p) => p.text && p.thought).map((p) => p.text).join('');
      const calls = m.parts.flatMap((p) => (p.call ? [{ id: p.call.id, type: 'function', function: { name: p.call.name, arguments: JSON.stringify(p.call.args ?? {}) } }] : []));
      out.push({ role: 'assistant', content: text, ...((flavor.deepseek || reasoning) && { reasoning_content: reasoning }), ...(calls.length && { tool_calls: calls }) });
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

class ToolCalls {
  private readonly open = new Map<number, { id?: string; name: string; args: string }>();
  private readonly closed = new Set<number>();

  add(pieces: ToolCallDelta[]) {
    for (const piece of pieces) {
      if (this.closed.has(piece.index)) {
        if (piece.function?.arguments?.trim()) throw new ModelError(502, `Tool call ${piece.index} streamed after it looked complete`);
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
      const args = parseToolArgs(call.args);
      if (!args || !call.args.trim()) break;
      yield [{ call: this.close(index, args) }];
    }
  }

  *flush(): Generator<Part[]> {
    for (const index of [...this.open.keys()].sort((a, b) => a - b)) yield [{ call: this.close(index, parseToolArgs(this.open.get(index)!.args)) }];
  }

  private close(index: number, args: Record<string, unknown> | null): ToolCall {
    const call = this.open.get(index)!;
    this.open.delete(index);
    this.closed.add(index);
    return { id: call.id || `call_${index}`, name: call.name, args };
  }
}

async function* streamChat(request: ModelRequest, options: ModelOptions, flavor: Flavor): AsyncGenerator<Part[]> {
  const body = {
    model: options.model,
    messages: messages(request, flavor),
    stream: true,
    ...(flavor.deepseek && { thinking: { type: 'enabled' } }),
    ...(request.tools?.length && {
      tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      ...(request.toolChoice === 'none' && { tool_choice: 'none' }),
    }),
    ...(flavor.deepseek && request.json && { response_format: { type: 'json_object' } }),
    ...(flavor.deepseek && request.temperature !== undefined && { temperature: request.temperature }),
  };
  const stream = sseStream(
    flavor.name,
    `${flavor.base(options)}/chat/completions`,
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
    const chunk = parseData<ChatChunk>(flavor.name, data);
    if (chunk.error) throw new ModelError(typeof chunk.error.code === 'number' ? chunk.error.code : 502, chunk.error.message ?? `${flavor.name} stream error`);
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) yield [{ text: reasoning, thought: true }];
    if (delta.content) yield [{ text: delta.content }];
    if (delta.tool_calls?.length) {
      calls.add(delta.tool_calls);
      yield* calls.ready();
    }
    if (choice.finish_reason) {
      const failed = FAILED_FINISH[choice.finish_reason];
      if (failed) throw new ModelError(failed, `${flavor.name} finished with ${choice.finish_reason}`);
      finished = true;
      yield* calls.flush();
    }
  }
  // 兼容服务各家实现不一，不发结束标记也照常收尾；DeepSeek 一定会发，没有就是被截断
  if (!finished && flavor.deepseek) throw new ModelError(502, 'DeepSeek stream ended before it finished');
  yield* calls.flush();
}

export const streamDeepSeek = (request: ModelRequest, options: ModelOptions) => streamChat(request, options, DEEPSEEK);
export const streamOpenAI = (request: ModelRequest, options: ModelOptions) => streamChat(request, options, OPENAI);

export async function checkDeepSeek({ apiKey, model, idleTimeout }: ModelKey) {
  await probe('DeepSeek', 'https://api.deepseek.com/chat/completions', idleTimeout, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, thinking: { type: 'disabled' } }),
  });
}

export async function checkOpenAI({ apiKey, baseUrl, model, idleTimeout }: ModelKey) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
  try {
    await probe(OPENAI.name, `${baseUrl}/models`, idleTimeout, { headers });
  } catch (err) {
    if (!(err instanceof ModelError) || (err.status !== 404 && err.status !== 405)) throw err;
    await probe(OPENAI.name, `${baseUrl}/chat/completions`, idleTimeout, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    });
  }
}
