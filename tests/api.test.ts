import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { UpgradeWebSocket } from 'hono/ws';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { createNodePlatform } from '../src/server/node/platform.ts';

const dir = mkdtempSync(join(tmpdir(), 'aapay-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function setup(env: Record<string, string>) {
  const config = loadConfig(env);
  const platform = createNodePlatform(join(dir, crypto.randomUUID()), (() => undefined) as unknown as UpgradeWebSocket);
  const app = createApp(async (c, next) => {
    c.set('config', config);
    c.set('platform', platform);
    await next();
  });
  let cookies = new Map<string, string>();
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`http://aapay.test/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair!.split('=');
      if (v) cookies.set(k!, v);
      else cookies.delete(k!);
    }
    return { status: res.status, data: (await res.json()) as any };
  };
  return { call, resetCookies: () => (cookies = new Map()) };
}

describe('API (isolated mode)', () => {
  const { call, resetCookies } = setup({ ADMIN_AUTH: 'none' });

  it('runs the full admin → passphrase → member flow', async () => {
    expect((await call('GET', '/config')).data).toEqual({ mode: 'isolated', adminAuth: 'none', mcp: true });
    expect((await call('GET', '/session')).data).toBeNull();

    const ledger = (await call('POST', '/admin/ledgers', { name: '周末露营' })).data;
    expect(ledger.name).toBe('周末露营');
    expect((await call('POST', '/admin/ledgers', { name: '周末露营' })).status).toBe(409);

    const phrase = (await call('POST', `/admin/ledgers/${ledger.id}/passphrases`, { code: 'Camp2026', validUntil: null })).data;
    expect((await call('POST', `/admin/ledgers/${ledger.id}/passphrases`, { code: 'camp2026', validUntil: null })).status).toBe(409);

    expect((await call('POST', '/join', { code: 'nope' })).status).toBe(401);
    const joined = await call('POST', '/join', { code: 'CAMP2026' });
    expect(joined.status).toBe(200);
    expect(joined.data).toMatchObject({ role: 'member', passphrase: 'Camp2026', ledger: { name: '周末露营' } });

    const a = (await call('POST', '/ledger/members', { name: '阿杰' })).data.event.member;
    const b = (await call('POST', '/ledger/members', { name: '小雨' })).data.event.member;
    const bad = await call('POST', '/ledger/expenses', { title: '', amount: 1, payerId: a.id, date: '2026-10-01', participantIds: [a.id] });
    expect(bad).toEqual({ status: 400, data: { error: '用途不能为空' } });

    const msg = (
      await call(
        'POST',
        '/ledger/expenses',
        { title: '营地', amount: 20000, payerId: a.id, date: '2026-10-01', participantIds: [a.id, b.id] },
        { 'x-client-id': 'tab-1' },
      )
    ).data;
    expect(msg).toMatchObject({ v: 3, origin: 'tab-1', event: { type: 'expense.saved' } });

    await call('POST', '/ledger/settlements', { fromId: b.id, toId: a.id, amount: 10000, date: '2026-10-02' });
    const snap = (await call('GET', '/ledger')).data;
    expect(snap).toMatchObject({ version: 4, ledger: { id: ledger.id } });
    expect(snap.expenses).toHaveLength(1);
    expect(snap.settlements).toHaveLength(1);

    const overview = (await call('GET', '/admin/ledgers')).data;
    expect(overview[0]).toMatchObject({ activePassphrases: 1, stats: { members: 2, expenses: 1, total: 20000 } });

    // 撤销口令后，成员会话立即失效
    await call('DELETE', `/admin/passphrases/${phrase.id}`);
    expect((await call('GET', '/ledger')).status).toBe(401);

    // 管理员可以直接进入账本
    const entered = (await call('POST', `/admin/ledgers/${ledger.id}/enter`)).data;
    expect(entered.role).toBe('admin');
    expect((await call('GET', '/ledger')).status).toBe(200);

    await call('DELETE', `/admin/ledgers/${ledger.id}`);
    expect((await call('GET', '/session')).data).toBeNull();
    resetCookies();
  });

  it('honours passphrase validity windows', async () => {
    const ledger = (await call('POST', '/admin/ledgers', { name: '未来' })).data;
    const now = Date.now();
    await call('POST', `/admin/ledgers/${ledger.id}/passphrases`, { code: 'later', validFrom: now + 60_000, validUntil: now + 120_000 });
    expect((await call('POST', '/join', { code: 'later' })).data.error).toBe('口令尚未生效');
  });

  it('rejects cross-site writes', async () => {
    const res = await call('POST', '/join', { code: 'abc' }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });
});

describe('API (admin auth)', () => {
  it('requires the admin password when configured', async () => {
    const { call } = setup({ ADMIN_AUTH: 'password', ADMIN_PASSWORD: 'correct-horse' });
    expect((await call('GET', '/admin/ledgers')).status).toBe(401);
    expect((await call('POST', '/admin/login', { password: 'wrong' })).status).toBe(401);
    expect((await call('POST', '/admin/login', { password: 'correct-horse' })).status).toBe(200);
    expect((await call('GET', '/admin/ledgers')).status).toBe(200);
  });

  it('hides the admin API when disabled', async () => {
    const { call } = setup({});
    expect((await call('GET', '/admin/ledgers')).status).toBe(404);
  });

  it('trusts the proxy header only for allowed emails', async () => {
    const { call } = setup({ ADMIN_AUTH: 'proxy', ADMIN_EMAILS: 'me@example.com' });
    expect((await call('GET', '/admin/me', undefined, { 'x-forwarded-email': 'evil@example.com' })).status).toBe(401);
    expect((await call('GET', '/admin/me', undefined, { 'x-forwarded-email': 'me@example.com' })).data.name).toBe('me@example.com');
  });
});

describe('API (shared mode)', () => {
  it('lets everyone in without a passphrase', async () => {
    const { call } = setup({ MODE: 'shared' });
    const session = (await call('GET', '/session')).data;
    expect(session).toMatchObject({ role: 'shared', ledger: { id: 'shared' } });
    expect((await call('POST', '/ledger/members', { name: '室友' })).status).toBe(200);
    expect((await call('POST', '/join', { code: 'abc' })).status).toBe(404);
  });
});
