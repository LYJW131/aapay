import { AppError, type ErrorStatus } from './errors.ts';

export type Remote<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

export type Envelope = { ok: true; value: unknown } | { ok: false; status: ErrorStatus; error: ReturnType<AppError['toJSON']> };

// AppError 无法原样穿过 Durable Object 的 RPC 边界，先转成普通对象，再由 remote() 还原
export function dispatch(target: object, method: string, args: unknown[]): Envelope {
  const fn = (target as Record<string, unknown>)[method];
  if (method.startsWith('_') || method === 'constructor' || typeof fn !== 'function') {
    return { ok: false, status: 400, error: new AppError(400, 'unknownMethod', { method }).toJSON() };
  }
  try {
    return { ok: true, value: (fn as (...a: unknown[]) => unknown).apply(target, args) };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, status: err.status, error: err.toJSON() };
    throw err;
  }
}

export function remote<T>(invoke: (method: string, args: unknown[]) => Promise<Envelope> | Envelope): Remote<T> {
  return new Proxy({} as Remote<T>, {
    get: (_, method) =>
      typeof method !== 'string'
        ? undefined
        : async (...args: unknown[]) => {
            const result = await invoke(method, args);
            if (result.ok) return result.value;
            throw AppError.fromJSON(result.status, result.error);
          },
  });
}
