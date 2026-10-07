import { vi } from 'vitest';
import type { GeminiPart } from '../../src/server/ai/gemini.ts';

export type Chunk = { candidates?: { content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string }[]; [key: string]: unknown };

export const parts = (...list: GeminiPart[]): Chunk => ({ candidates: [{ content: { role: 'model', parts: list } }] });
export const text = (t: string) => parts({ text: t });
export const call = (name: string, args: object, extra: Partial<GeminiPart> & { id?: string } = {}): Chunk => {
  const { id, ...rest } = extra;
  return parts({ functionCall: { name, args: args as Record<string, unknown>, ...(id && { id }) }, ...rest });
};

export function sseBody(chunks: Chunk[], pieces = 1) {
  const raw = chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(raw);
  const size = Math.max(1, Math.ceil(bytes.length / pieces));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
}

export type Reply = Chunk[] | Response;

export function stubGemini(replies: Reply[] | ((body: any, index: number) => Reply)) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : null;
    const index = requests.length;
    requests.push({ url, headers: init.headers as Record<string, string>, body });
    const reply = typeof replies === 'function' ? replies(body, index) : replies[index];
    if (!reply) throw new Error(`unexpected Gemini request #${index}`);
    if (reply instanceof Response) return reply;
    return new Response(sseBody(reply, 7), { headers: { 'content-type': 'text/event-stream' } });
  });
  return requests;
}
