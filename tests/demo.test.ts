import initSqlJs from 'sql.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoPlatform } from '../src/demo/platform.ts';
import { seedDemo, type Call } from '../src/demo/seed.ts';
import { clearCookies, createServer } from '../src/demo/server.ts';
import { parts } from './helpers/gemini.ts';

const ORIGIN = 'http://demo.test';

async function setup() {
  clearCookies();
  const SQL = await initSqlJs();
  const demo = createDemoPlatform(SQL, new Map());
  const serve = createServer(demo.platform, () => {});
  const call: Call = async (method, path, body) => {
    const res = await serve(`${ORIGIN}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok && res.status !== 302) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return (await res.json().catch(() => ({}))) as { id?: string };
  };
  const ledgers = await seedDemo(call);
  return { serve, demo, call, ledgers };
}

afterEach(() => vi.unstubAllGlobals());

describe('浏览器内的演示服务端', () => {
  it('中英两套演示数据都在，管理员按语言进入对应账本', async () => {
    const { serve, call, ledgers } = await setup();
    for (const [locale, name] of [
      ['zh-CN', '国庆出游'],
      ['en', 'Golden Week trip'],
    ] as const) {
      await call('POST', `/admin/ledgers/${ledgers[locale]}/enter`);
      const res = await serve(`${ORIGIN}/api/ledger`);
      expect(res.status).toBe(200);
      const snapshot = (await res.json()) as { ledger: { name: string }; expenses: unknown[]; members: unknown[] };
      expect(snapshot.ledger.name).toBe(name);
      expect(snapshot.members).toHaveLength(4);
      expect(snapshot.expenses).toHaveLength(12);
    }
  });

  it('导出后重新载入数据不丢', async () => {
    const { demo } = await setup();
    const SQL = await initSqlJs();
    const again = createDemoPlatform(SQL, demo.snapshot());
    expect(again.fresh).toBe(false);
    const ledgers = await again.platform.registry.listLedgers();
    expect(ledgers).toHaveLength(4);
  });

  it('中止请求会让读流报错并取消上游模型请求', async () => {
    const { serve } = await setup();
    let upstream: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      upstream = init.signal ?? undefined;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(parts({ text: '第一段' }))}\r\n\r\n`));
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const controller = new AbortController();
    const res = await serve(`${ORIGIN}/api/ledger/assistant`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-ai-provider': 'gemini', 'x-ai-key': 'test-key-123456' },
      body: JSON.stringify({ messages: [{ role: 'user', text: '你好' }], me: null, participants: null, today: '2026-10-05' }),
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('第一段')) seen += decoder.decode((await reader.read()).value);
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    await vi.waitFor(() => expect(upstream?.aborted).toBe(true));
  });
});
