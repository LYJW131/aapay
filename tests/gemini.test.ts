import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiError, streamGemini, type GeminiPart } from '../src/server/ai/gemini.ts';
import { LEDGER_TOOLS, inputSchema } from '../src/server/tools/ledger.ts';
import { call, parts, sseBody, stubGemini, text, type Chunk } from './helpers/gemini.ts';

afterEach(() => vi.unstubAllGlobals());

const options = { apiKey: 'test-key', model: 'gemini-test', idleTimeout: 1000 };

async function collect(request = { contents: [] }, extra: Partial<typeof options> & { signal?: AbortSignal } = {}) {
  const out: GeminiPart[][] = [];
  for await (const p of streamGemini(request, { ...options, ...extra })) out.push(p);
  return out;
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
  const expected = [[{ text: '你好' }], [{ functionCall: { name: 'get_ledger', args: {}, id: 'c1' }, thoughtSignature: 'sig' }], [{ text: '！\r\n' }]];

  it('parses CRLF-separated events however the bytes are split', async () => {
    const raw = await new Response(sseBody(chunks)).text();
    for (let i = 0; i <= raw.length; i++) {
      const pieces = [raw.slice(0, i), raw.slice(i)];
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
      expect(await collect()).toEqual(expected);
    }
  });

  it('posts to the streaming endpoint with the API key', async () => {
    const requests = stubGemini([[text('ok')]]);
    await collect({ contents: [] });
    expect(requests[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse');
    expect(requests[0]!.headers['x-goog-api-key']).toBe('test-key');
  });

  it('throws HTTP and in-stream failures with a status', async () => {
    stubGemini([Response.json({ error: { message: 'quota' } }, { status: 429 })]);
    await expect(collect()).rejects.toMatchObject({ name: 'GeminiError', status: 429 });

    stubGemini([[{ promptFeedback: { blockReason: 'SAFETY' } }]]);
    await expect(collect()).rejects.toBeInstanceOf(GeminiError);

    stubGemini([[text('partial'), { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }]]);
    await expect(collect()).rejects.toMatchObject({ status: 502 });

    stubGemini([[{ error: { code: 503, message: 'overloaded' } }]]);
    await expect(collect()).rejects.toMatchObject({ status: 503 });
  });

  it('times out when the upstream goes quiet and cancels the request', async () => {
    const signals = stubHang();
    await expect(collect(undefined, { idleTimeout: 30 })).rejects.toMatchObject({ name: 'GeminiError', status: 504 });
    expect(signals[0]!.aborted).toBe(true);

    stubHang([`data: ${JSON.stringify(text('开头'))}\r\n\r\n`]);
    const out: GeminiPart[][] = [];
    const stalled = (async () => {
      for await (const p of streamGemini({ contents: [] }, { ...options, idleTimeout: 30 })) out.push(p);
    })();
    await expect(stalled).rejects.toMatchObject({ status: 504 });
    expect(out).toEqual([[{ text: '开头' }]]);

    vi.stubGlobal('fetch', (_: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
    await expect(collect(undefined, { idleTimeout: 30 })).rejects.toMatchObject({ status: 504 });
  });

  it('passes a caller abort through instead of reporting a timeout', async () => {
    const signals = stubHang([`data: ${JSON.stringify(text('开头'))}\r\n\r\n`]);
    const caller = new AbortController();
    const run = (async () => {
      for await (const _ of streamGemini({ contents: [] }, { ...options, signal: caller.signal })) caller.abort(new Error('client left'));
    })();
    await expect(run).rejects.toThrow('client left');
    expect(signals[0]!.aborted).toBe(true);
  });

  it('ignores chunks without parts and keeps finished candidates', async () => {
    stubGemini([[parts(), { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] }]]);
    expect(await collect()).toEqual([[{ text: 'x' }]]);
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
