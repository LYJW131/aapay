import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicBaseUrl } from '../src/server/ai/base-url.ts';
import { checkOpenAI, streamDeepSeek, streamOpenAI } from '../src/server/ai/chat.ts';
import { streamClaude } from '../src/server/ai/claude.ts';
import { streamGemini } from '../src/server/ai/gemini.ts';
import { ModelError, type ModelRequest, type Part } from '../src/server/ai/model.ts';
import { LEDGER_TOOLS, inputSchema } from '../src/server/tools/ledger.ts';
import { bytes, dsCall, dsFinish, dsRaw, dsText, dsThink, dsUsage, stubDeepSeek } from './helpers/deepseek.ts';
import { blockStart, blockStop, delta, ping, start, stop, stubClaude, textBlock, thinkingBlock, toolBlock } from './helpers/claude.ts';
import { call, parts, sseBody, stubGemini, text, type Chunk } from './helpers/gemini.ts';

afterEach(() => vi.unstubAllGlobals());

const gemini = { provider: 'gemini' as const, apiKey: 'test-key', model: 'gemini-test', idleTimeout: 1000 };
const deepseek = { provider: 'deepseek' as const, apiKey: 'sk-test', model: 'deepseek-flash', idleTimeout: 1000 };
const empty: ModelRequest = { system: 'sys', messages: [] };

async function collect(stream: AsyncGenerator<Part[]>) {
  const out: Part[][] = [];
  for await (const p of stream) out.push(p);
  return out;
}

function stubRaw(raw: string, pieces: string[] = [raw]) {
  vi.stubGlobal('fetch', async () => {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const piece of pieces) controller.enqueue(encoder.encode(piece));
          controller.close();
        },
      }),
    );
  });
}

function stubHang(first: string[] = []) {
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', async (_: string, init: RequestInit) => {
    signals.push(init.signal!);
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const piece of first) controller.enqueue(encoder.encode(piece));
        },
      }),
    );
  });
  return signals;
}

describe('streamGemini', () => {
  const chunks: Chunk[] = [text('你好'), { usageMetadata: { totalTokenCount: 3 } }, call('get_ledger', {}, { id: 'c1', thoughtSignature: 'sig' }), text('！\r\n')];
  const expected = [[{ text: '你好' }], [{ call: { id: 'c1', name: 'get_ledger', args: {} }, signature: 'sig' }], [{ text: '！\r\n' }]];

  it('parses CRLF-separated events however the bytes are split', async () => {
    const raw = await new Response(sseBody(chunks)).text();
    for (let i = 0; i <= raw.length; i++) {
      stubRaw(raw, [raw.slice(0, i), raw.slice(i)]);
      expect(await collect(streamGemini(empty, gemini))).toEqual(expected);
    }
  });

  it('translates the request and echoes ids and signatures', async () => {
    const requests = stubGemini([[text('ok')]]);
    await collect(
      streamGemini(
        {
          system: 'sys',
          messages: [
            { role: 'user', parts: [{ text: 'hi' }, { image: { mimeType: 'image/png', data: 'AAAA' } }] },
            { role: 'model', parts: [{ signature: 's0' }, { call: { id: 'c1', name: 'get_ledger', args: {} }, signature: 's1' }] },
            { role: 'user', parts: [{ result: { id: 'c1', name: 'get_ledger', response: { ok: true } } }] },
          ],
          tools: [{ name: 'get_ledger', description: 'd', parameters: { type: 'object' } }],
          toolChoice: 'none',
          json: { type: 'object' },
          temperature: 0,
        },
        gemini,
      ),
    );
    expect(requests[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse');
    expect(requests[0]!.headers['x-goog-api-key']).toBe('test-key');
    expect(requests[0]!.body).toEqual({
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [
        { role: 'user', parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] },
        { role: 'model', parts: [{ text: '', thoughtSignature: 's0' }, { functionCall: { id: 'c1', name: 'get_ledger', args: {} }, thoughtSignature: 's1' }] },
        { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'get_ledger', response: { ok: true } } }] },
      ],
      tools: [{ functionDeclarations: [{ name: 'get_ledger', description: 'd', parametersJsonSchema: { type: 'object' } }] }],
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: { type: 'object' }, temperature: 0 },
    });
  });

  it('throws HTTP and in-stream failures with a status', async () => {
    stubGemini([Response.json({ error: { message: 'quota' } }, { status: 429 })]);
    await expect(collect(streamGemini(empty, gemini))).rejects.toMatchObject({ name: 'ModelError', status: 429 });

    stubGemini([[{ promptFeedback: { blockReason: 'SAFETY' } }]]);
    await expect(collect(streamGemini(empty, gemini))).rejects.toBeInstanceOf(ModelError);

    stubGemini([[text('partial'), { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }]]);
    await expect(collect(streamGemini(empty, gemini))).rejects.toMatchObject({ status: 502 });

    stubGemini([[{ error: { code: 503, message: 'overloaded' } }]]);
    await expect(collect(streamGemini(empty, gemini))).rejects.toMatchObject({ status: 503 });

    stubRaw('data: {"candidates": [\n\n');
    await expect(collect(streamGemini(empty, gemini))).rejects.toMatchObject({ name: 'ModelError', status: 502 });
  });

  it('times out when the upstream goes quiet and cancels the request', async () => {
    const signals = stubHang();
    await expect(collect(streamGemini(empty, { ...gemini, idleTimeout: 30 }))).rejects.toMatchObject({ name: 'ModelError', status: 504 });
    expect(signals[0]!.aborted).toBe(true);

    stubHang([`data: ${JSON.stringify(text('开头'))}\r\n\r\n`]);
    const out: Part[][] = [];
    const stalled = (async () => {
      for await (const p of streamGemini(empty, { ...gemini, idleTimeout: 30 })) out.push(p);
    })();
    await expect(stalled).rejects.toMatchObject({ status: 504 });
    expect(out).toEqual([[{ text: '开头' }]]);

    vi.stubGlobal('fetch', (_: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
    await expect(collect(streamGemini(empty, { ...gemini, idleTimeout: 30 }))).rejects.toMatchObject({ status: 504 });
  });

  it('reports dropped connections as an upstream failure', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(collect(streamGemini(empty, gemini))).rejects.toMatchObject({ name: 'ModelError', status: 502 });

    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(text('开头'))}\n\n`));
              controller.error(new TypeError('terminated'));
            },
          }),
        ),
    );
    await expect(collect(streamGemini(empty, gemini))).rejects.toMatchObject({ name: 'ModelError', status: 502 });
  });

  it('passes a caller abort through instead of reporting a timeout', async () => {
    const signals = stubHang([`data: ${JSON.stringify(text('开头'))}\r\n\r\n`]);
    const caller = new AbortController();
    const run = (async () => {
      for await (const _ of streamGemini(empty, { ...gemini, signal: caller.signal })) caller.abort(new Error('client left'));
    })();
    await expect(run).rejects.toThrow('client left');
    expect(signals[0]!.aborted).toBe(true);
  });

  it('ignores chunks without parts and keeps finished candidates', async () => {
    stubGemini([[parts(), { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] }]]);
    expect(await collect(streamGemini(empty, gemini))).toEqual([[{ text: 'x' }]]);
  });
});

describe('streamDeepSeek', () => {
  const chunks = [
    dsThink('先记'),
    dsThink('一笔'),
    dsText('好的'),
    dsCall(0, { id: 'call_a', name: 'add_expense', args: '' }),
    dsCall(0, { args: '{"title":"午' }),
    dsCall(0, { args: '饭","amount":45}' }),
    dsCall(1, { id: 'call_b', name: 'add_member', args: '{"name"' }),
    dsCall(1, { args: ':"Mia"}' }),
    dsFinish('tool_calls'),
    dsUsage,
  ];
  const expected = [
    [{ text: '先记', thought: true }],
    [{ text: '一笔', thought: true }],
    [{ text: '好的' }],
    [{ call: { id: 'call_a', name: 'add_expense', args: { title: '午饭', amount: 45 } } }],
    [{ call: { id: 'call_b', name: 'add_member', args: { name: 'Mia' } } }],
  ];

  it('parses keep-alives, CRLF, usage and [DONE] however the bytes are split', async () => {
    const raw = dsRaw(chunks);
    for (let i = 0; i <= raw.length; i += 3) {
      stubRaw(raw, [raw.slice(0, i), raw.slice(i)]);
      expect(await collect(streamDeepSeek(empty, deepseek))).toEqual(expected);
    }
  });

  it('releases a tool call as soon as the next one starts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const encoder = new TextEncoder();
    const head = dsRaw([dsCall(0, { id: 'a', name: 'add_member', args: '{"name":"A"}' }), dsCall(1, { id: 'b', name: 'add_member', args: '{"na' })]).replace('data: [DONE]\r\n\r\n', '');
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode(head));
              await gate;
              controller.enqueue(encoder.encode(dsRaw([dsCall(1, { args: 'me":"B"}' }), dsFinish('tool_calls')])));
              controller.close();
            },
          }),
        ),
    );
    const seen: Part[][] = [];
    for await (const p of streamDeepSeek(empty, deepseek)) {
      seen.push(p);
      if (seen.length === 1) {
        expect(p).toEqual([{ call: { id: 'a', name: 'add_member', args: { name: 'A' } } }]);
        release();
      }
    }
    expect(seen.map((p) => p[0]!.call!.id)).toEqual(['a', 'b']);
  });

  it('waits for interleaved fragments and reports unparseable arguments as null', async () => {
    stubRaw(
      dsRaw([
        dsCall(0, { id: 'a', name: 'add_expense', args: '{"title":"x",' }),
        dsCall(1, { id: 'b', name: 'add_member', args: '{"name":' }),
        dsCall(0, { args: '"amount":1}' }),
        dsCall(1, { args: '"Mia"}' }),
        dsCall(2, { name: 'get_ledger', args: '{oops' }),
        dsFinish('tool_calls'),
      ]),
    );
    expect(await collect(streamDeepSeek(empty, deepseek))).toEqual([
      [{ call: { id: 'a', name: 'add_expense', args: { title: 'x', amount: 1 } } }],
      [{ call: { id: 'b', name: 'add_member', args: { name: 'Mia' } } }],
      [{ call: { id: 'call_2', name: 'get_ledger', args: null } }],
    ]);
  });

  it('treats a stream cut off before it finished as a failure', async () => {
    stubRaw(`data: ${JSON.stringify(dsText('半截'))}\n\ndata: ${JSON.stringify(dsCall(0, { id: 'a', name: 'get_ledger', args: '{"x":' }))}\n\n`);
    await expect(collect(streamDeepSeek(empty, deepseek))).rejects.toMatchObject({ name: 'ModelError', status: 502 });
  });

  it('does not repeat a name sent again and ignores blank fragments after a call closed', async () => {
    stubRaw(
      dsRaw([
        dsCall(0, { id: 'a', name: 'get_ledger', args: '{}' }),
        dsCall(0, { name: 'get_ledger' }),
        dsCall(1, { id: 'b', name: 'add_member', args: '{"name":"M"}' }),
        dsCall(0, { args: ' ' }),
        dsFinish('tool_calls'),
      ]),
    );
    expect(await collect(streamDeepSeek(empty, deepseek))).toEqual([
      [{ call: { id: 'a', name: 'get_ledger', args: {} } }],
      [{ call: { id: 'b', name: 'add_member', args: { name: 'M' } } }],
    ]);
  });

  it('translates the request into chat messages with reasoning and tool results', async () => {
    const requests = stubDeepSeek([[dsText('ok'), dsFinish('stop')]]);
    await collect(
      streamDeepSeek(
        {
          system: 'sys',
          messages: [
            { role: 'user', parts: [{ text: 'hi' }] },
            { role: 'model', parts: [{ text: '想想', thought: true }, { text: '查一下' }, { call: { id: 'c1', name: 'get_ledger', args: {} } }] },
            { role: 'user', parts: [{ result: { id: 'c1', name: 'get_ledger', response: { ok: true } } }] },
            { role: 'model', parts: [{ call: { id: 'c2', name: 'get_ledger', args: {} } }] },
            { role: 'user', parts: [{ result: { id: 'c2', name: 'get_ledger', response: { ok: true } } }] },
            { role: 'user', parts: [{ image: { mimeType: 'image/png', data: 'AAAA' } }, { text: 'look' }] },
          ],
          tools: [{ name: 'get_ledger', description: 'd', parameters: { type: 'object' } }],
          toolChoice: 'none',
        },
        deepseek,
      ),
    );
    expect(requests[0]!.url).toBe('https://api.deepseek.com/chat/completions');
    expect(requests[0]!.headers.authorization).toBe('Bearer sk-test');
    expect(requests[0]!.body).toEqual({
      model: 'deepseek-flash',
      stream: true,
      thinking: { type: 'enabled' },
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '查一下', reasoning_content: '想想', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_ledger', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
        { role: 'assistant', content: '', reasoning_content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'get_ledger', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c2', content: '{"ok":true}' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: 'look' }] },
      ],
      tools: [{ type: 'function', function: { name: 'get_ledger', description: 'd', parameters: { type: 'object' } } }],
      tool_choice: 'none',
    });
  });

  it('asks for a json object with the schema in the prompt', async () => {
    const requests = stubDeepSeek([[dsText('{"items":[]}'), dsFinish('stop')]]);
    await collect(streamDeepSeek({ system: 'Extract.', messages: [], json: { type: 'object', required: ['items'] }, temperature: 0 }, deepseek));
    const body = requests[0]!.body;
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBe(0);
    expect(body.messages[0].content).toContain('json object');
    expect(body.messages[0].content).toContain('{"type":"object","required":["items"]}');
  });

  it('fails on HTTP errors, in-stream errors and bad finish reasons', async () => {
    stubDeepSeek([Response.json({ error: { message: 'Authentication Fails' } }, { status: 401 })]);
    await expect(collect(streamDeepSeek(empty, deepseek))).rejects.toMatchObject({ name: 'ModelError', status: 401 });

    stubDeepSeek([[dsText('部分'), dsFinish('insufficient_system_resource')]]);
    await expect(collect(streamDeepSeek(empty, deepseek))).rejects.toMatchObject({ status: 503 });

    stubDeepSeek([[dsFinish('content_filter')]]);
    await expect(collect(streamDeepSeek(empty, deepseek))).rejects.toMatchObject({ status: 502 });

    stubDeepSeek([[{ error: { message: 'boom' } }]]);
    await expect(collect(streamDeepSeek(empty, deepseek))).rejects.toMatchObject({ status: 502 });

    stubRaw('data: {"choices": [\n\n');
    await expect(collect(streamDeepSeek(empty, deepseek))).rejects.toMatchObject({ status: 502 });
  });

  it('times out when DeepSeek only sends keep-alives', async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      async (_: string, init: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              const timer = setInterval(() => controller.enqueue(encoder.encode(': keep-alive\n\n')), 10);
              init.signal!.addEventListener('abort', () => clearInterval(timer));
            },
          }),
        ),
    );
    await expect(collect(streamDeepSeek(empty, { ...deepseek, idleTimeout: 200 }))).rejects.toMatchObject({ name: 'ModelError', status: 504 });
  }, 5000);

  it('keeps byte streams intact across multi-byte characters', async () => {
    vi.stubGlobal('fetch', async () => new Response(bytes(dsRaw([dsText('瑞幸咖啡☕'), dsFinish('stop')]), 97)));
    expect(await collect(streamDeepSeek(empty, deepseek))).toEqual([[{ text: '瑞幸咖啡☕' }]]);
  });
});

const claude = { provider: 'claude' as const, apiKey: 'sk-ant-test', model: 'claude-haiku-5-5', idleTimeout: 1000 };
const openai = { provider: 'openai' as const, apiKey: 'sk-test', model: 'Qwen/Qwen3-Max', baseUrl: 'https://llm.example.com/v1', idleTimeout: 1000 };

describe('streamClaude', () => {
  it('streams text, closes tool calls block by block and keeps thinking for the next round', async () => {
    stubClaude([
      [
        start,
        ping,
        ...thinkingBlock(0, 'sig-1'),
        ...textBlock(1, '好', '的'),
        ...toolBlock(2, 'toolu_a', 'add_member', '{"na', 'me":"Mia"}'),
        ...toolBlock(3, 'toolu_b', 'get_ledger', ''),
        blockStart(4, { type: 'redacted_thinking', data: 'opaque' }),
        blockStop(4),
        ...stop('tool_use'),
      ],
    ]);
    expect(await collect(streamClaude(empty, claude))).toEqual([
      [{ text: '', thought: true, signature: 'sig-1' }],
      [{ text: '好' }],
      [{ text: '的' }],
      [{ call: { id: 'toolu_a', name: 'add_member', args: { name: 'Mia' } } }],
      [{ call: { id: 'toolu_b', name: 'get_ledger', args: {} } }],
      [{ thought: true, redacted: true, signature: 'opaque' }],
    ]);
  });

  it('reports unparseable tool input as null', async () => {
    stubClaude([[start, ...toolBlock(0, 'toolu_a', 'add_member', '{"name":'), ...stop('max_tokens')]]);
    expect(await collect(streamClaude(empty, claude))).toEqual([[{ call: { id: 'toolu_a', name: 'add_member', args: null } }]]);
  });

  it('translates the request with thinking echo, caching, eager tools and a strict output schema', async () => {
    const requests = stubClaude([[start, ...textBlock(0, 'ok'), ...stop()]]);
    await collect(
      streamClaude(
        {
          system: 'sys',
          messages: [
            { role: 'user', parts: [{ text: 'hi' }, { image: { mimeType: 'image/jpeg', data: 'AAAA' } }] },
            { role: 'model', parts: [{ text: '', thought: true, signature: 's1' }, { thought: true, redacted: true, signature: 'r1' }, { call: { id: 't1', name: 'get_ledger', args: {} } }] },
            { role: 'user', parts: [{ result: { id: 't1', name: 'get_ledger', response: { ok: true } } }] },
          ],
          tools: [{ name: 'get_ledger', description: 'd', parameters: { type: 'object' } }],
          toolChoice: 'none',
          json: { type: 'object', properties: { items: { type: 'array', maxItems: 3, items: { type: 'object', properties: { a: { type: 'number' } } } } } },
          temperature: 0,
        },
        claude,
      ),
    );
    expect(requests[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(requests[0]!.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(requests[0]!.body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 16000,
      stream: true,
      cache_control: { type: 'ephemeral' },
      system: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 's1' },
            { type: 'redacted_thinking', data: 'r1' },
            { type: 'tool_use', id: 't1', name: 'get_ledger', input: {} },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }] },
      ],
      tools: [{ name: 'get_ledger', description: 'd', input_schema: { type: 'object' }, eager_input_streaming: true }],
      tool_choice: { type: 'none' },
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { a: { type: 'number' } } } } },
          },
        },
      },
    });
  });

  it('maps HTTP errors, stream errors, refusals and silence to model errors', async () => {
    stubClaude([Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 })]);
    await expect(collect(streamClaude(empty, claude))).rejects.toMatchObject({ name: 'ModelError', status: 401 });

    stubClaude([[start, ...textBlock(0, '部分'), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]]);
    await expect(collect(streamClaude(empty, claude))).rejects.toMatchObject({ name: 'ModelError', status: 502 });

    stubClaude([[start, ...stop('refusal')]]);
    await expect(collect(streamClaude(empty, claude))).rejects.toMatchObject({ name: 'ModelError', status: 502 });

    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      async (_: unknown, init: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`));
              const timer = setInterval(() => controller.enqueue(encoder.encode(`event: ping\ndata: {"type":"ping"}\n\n`)), 10);
              init.signal?.addEventListener('abort', () => clearInterval(timer));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    await expect(collect(streamClaude(empty, { ...claude, idleTimeout: 150 }))).rejects.toMatchObject({ name: 'ModelError', status: 504 });
  });
});

describe('streamOpenAI', () => {
  it('sends a plain chat request to the custom base URL and reads the reasoning field', async () => {
    const requests = stubDeepSeek([[{ choices: [{ delta: { reasoning: '想' } }] }, dsText('好'), dsCall(0, { id: 'c', name: 'get_ledger', args: '{}' })]]);
    const out = await collect(
      streamOpenAI(
        { system: 'Extract.', messages: [{ role: 'model', parts: [{ text: '上一轮' }] }], json: { type: 'object' }, temperature: 0, tools: [{ name: 'get_ledger', description: 'd', parameters: {} }] },
        openai,
      ),
    );
    expect(out).toEqual([[{ text: '想', thought: true }], [{ text: '好' }], [{ call: { id: 'c', name: 'get_ledger', args: {} } }]]);
    expect(requests[0]!.url).toBe('https://llm.example.com/v1/chat/completions');
    const body = requests[0]!.body;
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('temperature');
    expect(body.model).toBe('Qwen/Qwen3-Max');
    expect(body.messages[0].content).toContain('json object');
    expect(body.messages[1]).toEqual({ role: 'assistant', content: '上一轮' });
  });

  it('checks a key with /models and falls back to a tiny chat request', async () => {
    const requests = stubDeepSeek([new Response('{}', { status: 404 }), Response.json({ choices: [] })]);
    await checkOpenAI(openai);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET https://llm.example.com/v1/models', 'POST https://llm.example.com/v1/chat/completions']);
    stubDeepSeek([new Response('{}', { status: 401 })]);
    await expect(checkOpenAI(openai)).rejects.toMatchObject({ status: 401 });
  });
});

describe('publicBaseUrl', () => {
  it('accepts public https addresses and rejects everything a server should not fetch for a user', () => {
    expect(publicBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(publicBaseUrl(' https://openrouter.ai/api/v1 ')).toBe('https://openrouter.ai/api/v1');
    for (const bad of [
      'http://api.example.com/v1',
      'https://localhost/v1',
      'https://foo.localhost',
      'https://127.0.0.1/v1',
      'https://10.0.0.5',
      'https://172.20.1.1',
      'https://192.168.1.10:8443/v1',
      'https://169.254.169.254/latest',
      'https://100.64.0.1',
      'https://[::1]/v1',
      'https://[fd00::1]/v1',
      'https://user:pass@api.example.com',
      'https://api.example.com/v1?x=1',
      'ftp://api.example.com',
      'not a url',
    ])
      expect(publicBaseUrl(bad), bad).toBeNull();
  });
});

describe('tool schemas', () => {
  it('are plain JSON Schema objects without a $schema key', () => {
    for (const tool of LEDGER_TOOLS) {
      const schema = inputSchema(tool.input) as Record<string, unknown>;
      expect(schema).not.toHaveProperty('$schema');
      expect(schema.type).toBe('object');
    }
  });
});
