import { common } from '../i18n/common.ts';
import { locale } from '../i18n/locale.ts';
import { parseSse, type SseMessage } from '../../shared/sse.ts';
import { ApiError, CLIENT_ID } from './api.ts';

export async function* streamSse(url: string, body: unknown, signal?: AbortSignal, headers: Record<string, string> = {}): AsyncGenerator<SseMessage> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': CLIENT_ID, 'accept-language': locale, accept: 'text/event-stream', ...headers },
      credentials: 'same-origin',
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError(0, common.networkError);
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error ?? common.requestFailed(res.status));
  }

  const queue: SseMessage[] = [];
  const parser = parseSse((m) => queue.push(m));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const read = async () => {
    try {
      return await reader.read();
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ApiError(0, common.networkError);
    }
  };
  try {
    while (true) {
      const { done, value } = await read();
      if (done) parser.end();
      else parser.push(value);
      while (queue.length) yield queue.shift()!;
      if (done) return;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
