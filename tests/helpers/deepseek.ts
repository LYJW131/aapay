import { vi } from 'vitest';

export type DsChunk = Record<string, unknown>;

export const dsText = (content: string): DsChunk => ({ choices: [{ index: 0, delta: { content } }] });
export const dsThink = (reasoning_content: string): DsChunk => ({ choices: [{ index: 0, delta: { reasoning_content } }] });
export const dsCall = (index: number, piece: { id?: string; name?: string; args?: string }): DsChunk => ({
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          { index, ...(piece.id && { id: piece.id, type: 'function' }), function: { ...(piece.name && { name: piece.name }), ...(piece.args !== undefined && { arguments: piece.args }) } },
        ],
      },
    },
  ],
});
export const dsFinish = (finish_reason: string): DsChunk => ({ choices: [{ index: 0, delta: {}, finish_reason }] });
export const dsUsage: DsChunk = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };

export function dsRaw(chunks: DsChunk[]) {
  return chunks.map((c) => `: keep-alive\r\n\r\ndata: ${JSON.stringify(c)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
}

export function bytes(raw: string, pieces = 1) {
  const encoded = new TextEncoder().encode(raw);
  const size = Math.max(1, Math.ceil(encoded.length / pieces));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < encoded.length; i += size) controller.enqueue(encoded.slice(i, i + size));
      controller.close();
    },
  });
}

export type DsReply = DsChunk[] | Response;

export function stubDeepSeek(replies: DsReply[] | ((body: any, index: number) => DsReply)) {
  const requests: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : null;
    const index = requests.length;
    requests.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body });
    const reply = typeof replies === 'function' ? replies(body, index) : replies[index];
    if (!reply) throw new Error(`unexpected DeepSeek request #${index}`);
    if (reply instanceof Response) return reply;
    return new Response(bytes(dsRaw(reply), 9), { headers: { 'content-type': 'text/event-stream' } });
  });
  return requests;
}
