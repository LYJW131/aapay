import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiError, streamGemini, type GeminiPart } from '../src/server/ai/gemini.ts';
import { LEDGER_TOOLS, inputSchema } from '../src/server/tools/ledger.ts';
import { call, parts, sseBody, stubGemini, text, type Chunk } from './helpers/gemini.ts';

afterEach(() => vi.unstubAllGlobals());

const options = { apiKey: 'test-key', model: 'gemini-test' };

async function collect(request = { contents: [] }) {
  const out: GeminiPart[][] = [];
  for await (const p of streamGemini(request, options)) out.push(p);
  return out;
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
