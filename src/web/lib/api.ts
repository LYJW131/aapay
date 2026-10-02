import { hc, type ClientResponse } from 'hono/client';
import type { ApiType } from '../../server/app.ts';

// 服务端把它带回实时事件，用来识别自己发起的变更
export const CLIENT_ID = crypto.randomUUID();

export const api = hc<ApiType>('/api', {
  headers: { 'x-client-id': CLIENT_ID },
  init: { credentials: 'same-origin' },
});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Body<R> = R extends ClientResponse<infer T, number, string> ? T : never;
type Ok<R> = Exclude<Body<R>, { error: string }>;

export async function call<R extends ClientResponse<unknown, number, string>>(request: Promise<R>): Promise<Ok<R>> {
  let res: R;
  try {
    res = await request;
  } catch {
    throw new ApiError(0, '网络连接失败，请检查网络');
  }
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `请求失败（${res.status}）`);
  return data as Ok<R>;
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : '操作失败');

export function liveUrl(path: string) {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/api${path}`;
}
