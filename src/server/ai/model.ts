import type { AiProvider } from '../../shared/assistant.ts';
import { parseSse } from '../../shared/sse.ts';

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown> | null;
}

export interface Part {
  text?: string;
  thought?: boolean;
  signature?: string;
  image?: { mimeType: string; data: string };
  call?: ToolCall;
  result?: { id?: string; name: string; response: object };
}

export interface Message {
  role: 'user' | 'model';
  parts: Part[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: object;
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none';
  json?: object;
  temperature?: number;
}

export interface ModelKey {
  provider: AiProvider;
  apiKey: string;
  model: string;
  idleTimeout: number;
}

export interface ModelOptions extends ModelKey {
  signal?: AbortSignal;
}

export class ModelError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
  }
}

export function parseData<T>(name: string, data: string): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    throw new ModelError(502, `${name} sent malformed data: ${data.slice(0, 120)}`);
  }
}

export async function* sseStream(
  name: string,
  url: string,
  init: RequestInit,
  { idleTimeout, signal }: { idleTimeout: number; signal?: AbortSignal },
): AsyncGenerator<string> {
  const controller = new AbortController();
  const relay = () => controller.abort(signal?.reason);
  if (signal?.aborted) relay();
  signal?.addEventListener('abort', relay, { once: true });
  let timedOut = false;
  let deadline = Date.now() + idleTimeout;

  // 只在等上游时计时：调用方处理事件（执行工具、写 SSE）期间不算空闲；
  // 只有数据事件才续期，排队时上游只发 keep-alive 注释，照样会超时
  const wait = <T>(work: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          timedOut = true;
          controller.abort();
        },
        Math.max(0, deadline - Date.now()),
      );
      const settle = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', aborted);
      };
      const fail = (err: unknown) => {
        settle();
        if (timedOut) reject(new ModelError(504, `${name} sent nothing for ${idleTimeout}ms`));
        else if (signal?.aborted || err instanceof ModelError) reject(err);
        else reject(new ModelError(502, `${name} connection failed: ${String(err)}`));
      };
      const aborted = () => fail(controller.signal.reason);
      work.then((value) => {
        settle();
        resolve(value);
      }, fail);
      if (controller.signal.aborted) aborted();
      else controller.signal.addEventListener('abort', aborted, { once: true });
    });

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const res = await wait(fetch(url, { ...init, signal: controller.signal }));
    deadline = Date.now() + idleTimeout;
    if (!res.ok || !res.body) throw new ModelError(res.status, `${name} ${res.status}: ${(await wait(res.text())).slice(0, 300)}`);
    const decoder = new TextDecoder();
    const queue: string[] = [];
    const parser = parseSse((m) => queue.push(m.data));
    reader = res.body.getReader();
    for (;;) {
      const { done, value } = await wait(reader.read());
      if (done) {
        parser.push(decoder.decode());
        parser.end();
      } else parser.push(decoder.decode(value, { stream: true }));
      while (queue.length) {
        yield queue.shift()!;
        deadline = Date.now() + idleTimeout;
      }
      if (done) return;
    }
  } finally {
    signal?.removeEventListener('abort', relay);
    reader?.cancel().catch(() => {});
    controller.abort();
  }
}

export async function probe(name: string, url: string, idleTimeout: number, init: RequestInit = {}) {
  const unreachable = (err: unknown) =>
    new ModelError(err instanceof DOMException && err.name === 'TimeoutError' ? 504 : 502, `${name} unreachable: ${String(err)}`);
  const signal = AbortSignal.timeout(idleTimeout);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (err) {
    throw unreachable(err);
  }
  const body = await res.text().catch((err: unknown) => {
    throw unreachable(err);
  });
  if (!res.ok) throw new ModelError(res.status, `${name} ${res.status}: ${body.slice(0, 300)}`);
}
