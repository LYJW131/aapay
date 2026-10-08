import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { UpgradeWebSocket } from 'hono/ws';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { createNodePlatform } from '../src/server/node/platform.ts';
import { newId } from '../src/shared/ids.ts';

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
    const text = await res.text();
    const location = res.headers.get('location');
    return { status: res.status, ...(location && { location }), data: (text ? JSON.parse(text) : null) as any };
  };
  const login = (returnTo?: string, headers: Record<string, string> = {}) =>
    call('GET', `/admin/login${returnTo === undefined ? '' : `?return_to=${encodeURIComponent(returnTo)}`}`, undefined, headers);
  return { call, login, config, resetCookies: () => (cookies = new Map()) };
}

describe('API (isolated mode)', () => {
  const { call, login, resetCookies } = setup({ ADMIN_AUTH: 'none' });

  it('runs the full admin → passphrase → member flow', async () => {
    expect((await call('GET', '/config')).data).toEqual({ mode: 'isolated', adminAuth: 'none', mcp: true, assistant: { provider: 'gemini', builtin: false, models: { gemini: 'gemini-flash-lite-latest', deepseek: 'deepseek-flash' } } });
    expect((await call('GET', '/session')).data).toEqual({ session: null, admin: null });
    expect((await call('GET', '/admin/ledgers')).status).toBe(401);
    expect(await login('/oauth/authorize?client_id=x')).toMatchObject({ status: 302, location: '/oauth/authorize?client_id=x' });
    expect((await call('GET', '/session')).data).toEqual({ session: null, admin: { name: 'developer' } });

    const ledger = (await call('POST', '/admin/ledgers', { name: '周末露营' })).data;
    expect(ledger.name).toBe('周末露营');
    expect((await call('POST', '/admin/ledgers', { name: '周末露营' })).status).toBe(409);

    const phrase = (await call('POST', `/admin/ledgers/${ledger.id}/passphrases`, { code: 'Camp2026', validUntil: null })).data;
    expect((await call('POST', `/admin/ledgers/${ledger.id}/passphrases`, { code: 'camp2026', validUntil: null })).status).toBe(409);

    expect((await call('POST', '/join', { code: 'nope' })).status).toBe(401);
    const joined = await call('POST', '/join', { code: 'CAMP2026' });
    expect(joined.status).toBe(200);
    expect(joined.data).toMatchObject({ role: 'member', passphrase: 'Camp2026', ledger: { name: '周末露营' } });

    const changes = (list: unknown[], headers?: Record<string, string>) => call('POST', '/ledger/changes', { changes: list }, headers);
    const a = { id: newId() };
    const b = { id: newId() };
    const joinedMembers = (
      await changes([
        { op: 'member.create', id: a.id, member: { name: '阿杰' } },
        { op: 'member.create', id: b.id, member: { name: '小雨' } },
      ])
    ).data;
    expect(joinedMembers.messages.map((m: { v: number }) => m.v)).toEqual([1, 2]);
    expect(joinedMembers.undo).toEqual([
      { op: 'member.delete', id: b.id },
      { op: 'member.delete', id: a.id },
    ]);

    const expense = (extra: object) => ({
      op: 'expense.create',
      id: newId(),
      expense: { title: '营地', amount: 20000, payerId: a.id, date: '2026-10-01', category: 'lodging', split: { mode: 'even', memberIds: [a.id, b.id] }, ...extra },
    });
    const english = { 'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8' };
    expect(await changes([expense({ title: '' })])).toEqual({ status: 400, data: { error: '用途不能为空' } });
    expect((await changes([expense({ title: '' })], english)).data.error).toBe('Description is required');
    const uneven = { split: { mode: 'exact', shares: [{ memberId: a.id, amount: 100 }, { memberId: b.id, amount: 100 }] } };
    expect((await changes([expense(uneven)])).data.error).toBe('各人金额之和需等于总额');
    expect((await changes([expense(uneven)], english)).data.error).toBe('Shares must add up to the total');
    expect((await changes([expense({ category: 'snacks' })], english)).data.error).toBe('Invalid category');
    expect((await changes([], english)).data.error).toBe('Nothing to save');
    expect((await changes([{ op: 'member.create', id: newId(), member: { name: '阿杰' } }], english)).data.error).toBe('A member named “阿杰” already exists');
    expect(await changes([{ op: 'member.create', id: a.id, member: { name: '新人' } }])).toEqual({ status: 409, data: { error: '这条记录已存在' } });

    const created = (await changes([expense({})], { 'x-client-id': 'tab-1' })).data;
    expect(created.messages).toMatchObject([{ v: 3, origin: 'tab-1', event: { type: 'expense.saved', expense: { category: 'lodging' } } }]);
    expect(created.messages[0]).not.toHaveProperty('via');
    const assisted = (
      await call('POST', '/ledger/changes', {
        changes: [{ op: 'settlement.create', id: newId(), settlement: { fromId: b.id, toId: a.id, amount: 10000, date: '2026-10-02' } }],
        via: 'assistant',
      })
    ).data;
    expect(assisted.messages[0]).toMatchObject({ v: 4, via: 'assistant', batch: { size: 1 } });
    const audit = (await call('GET', '/ledger/audit?limit=1')).data.records[0];
    expect(JSON.parse(audit.payload)).toMatchObject({ via: 'assistant', actor: { kind: 'member', passphrase: 'Camp2026' } });

    const snap = (await call('GET', '/ledger')).data;
    expect(snap).toMatchObject({ version: 4, ledger: { id: ledger.id } });
    expect(snap.expenses).toHaveLength(1);
    expect(snap.settlements).toHaveLength(1);

    const overview = (await call('GET', '/admin/ledgers')).data;
    expect(overview[0]).toMatchObject({ activePassphrases: 1, stats: { members: 2, expenses: 1, total: 20000 } });

    await call('DELETE', `/admin/passphrases/${phrase.id}`);
    expect((await call('GET', '/ledger')).status).toBe(401);

    const entered = (await call('POST', `/admin/ledgers/${ledger.id}/enter`)).data;
    expect(entered.role).toBe('admin');
    expect((await call('GET', '/ledger')).status).toBe(200);

    await call('DELETE', `/admin/ledgers/${ledger.id}`);
    expect((await call('GET', '/session')).data.session).toBeNull();
    resetCookies();
  });

  it('maps rejected change sets to 400, 404 and 409', async () => {
    await login();
    const ledger = (await call('POST', '/admin/ledgers', { name: '改动校验' })).data;
    await call('POST', `/admin/ledgers/${ledger.id}/enter`);
    const changes = (list: unknown[]) => call('POST', '/ledger/changes', { changes: list });
    const member = (name: string) => ({ op: 'member.create', id: newId(), member: { name } });
    const a = newId();
    const id = newId();
    const expense = (title: string) => ({ title, amount: 1000, payerId: a, date: '2026-10-01', category: null, split: { mode: 'even', memberIds: [a] } });
    await changes([{ op: 'member.create', id: a, member: { name: '阿杰' } }, { op: 'expense.create', id, expense: expense('晚饭') }]);
    const seen = (await call('GET', '/ledger')).data.expenses[0].updatedAt;

    expect(await changes([])).toEqual({ status: 400, data: { error: '没有要保存的改动' } });
    expect(await changes(Array.from({ length: 101 }, (_, i) => member(`成员${i}`)))).toEqual({ status: 400, data: { error: '一次最多 100 项改动' } });
    expect(await changes([{ op: 'member.create', id: 'bad id', member: { name: '新人' } }])).toEqual({ status: 400, data: { error: '记录 ID 无效' } });
    expect(await changes([{ op: 'expense.update', id: newId(), expense: expense('午饭') }])).toEqual({ status: 404, data: { error: '这笔支出不存在或已被删除' } });
    expect(await changes([{ op: 'expense.delete', id: newId() }])).toEqual({ status: 404, data: { error: '这笔支出不存在或已被删除' } });
    expect(await changes([{ op: 'member.delete', id: newId() }])).toEqual({ status: 404, data: { error: '成员不存在' } });
    expect(await changes([{ op: 'settlement.delete', id: newId() }])).toEqual({ status: 404, data: { error: '这笔还款不存在或已被删除' } });

    expect((await changes([{ op: 'expense.update', id, expense: expense('夜宵'), ifUpdatedAt: seen }])).status).toBe(200);
    expect(await changes([{ op: 'expense.delete', id, ifUpdatedAt: seen }])).toEqual({ status: 409, data: { error: '这笔账刚被改过，请刷新后再试' } });
    expect(await changes([member('小雨'), { op: 'expense.update', id, expense: expense('早饭'), ifUpdatedAt: seen }])).toMatchObject({ status: 409 });
    const after = (await call('GET', '/ledger')).data;
    expect(after.members.map((m: { name: string }) => m.name)).toEqual(['阿杰']);
    expect(after.expenses[0].title).toBe('夜宵');

    await call('DELETE', `/admin/ledgers/${ledger.id}`);
    resetCookies();
  });

  it('ends ledger sessions opened by an admin together with the admin session', async () => {
    await login();
    const ledger = (await call('POST', '/admin/ledgers', { name: '管理员会话' })).data;
    expect((await call('POST', `/admin/ledgers/${ledger.id}/enter`)).data).toMatchObject({ role: 'admin', subject: 'developer' });
    expect((await call('GET', '/ledger')).status).toBe(200);
    await call('POST', '/admin/logout');
    expect((await call('GET', '/session')).data).toEqual({ session: null, admin: null });
    expect((await call('GET', '/ledger')).status).toBe(401);
    resetCookies();
  });

  it('only redirects back to same-site paths after login', async () => {
    for (const evil of ['https://evil.example/x', '//evil.example/x', '/\\evil.example/x', 'javascript:alert(1)']) {
      expect((await login(evil)).location).toBe('/');
    }
    expect((await login()).location).toBe('/');
    resetCookies();
  });

  it('honours passphrase validity windows', async () => {
    await login();
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
    const { call, login } = setup({ ADMIN_AUTH: 'password', ADMIN_PASSWORD: 'correct-horse' });
    expect((await call('GET', '/admin/ledgers')).status).toBe(401);
    expect(await login('/x')).toMatchObject({ status: 302, location: '/admin?return_to=%2Fx' });
    expect((await call('GET', '/admin/ledgers')).status).toBe(401);
    expect((await call('POST', '/admin/login', { password: 'wrong' })).status).toBe(401);
    expect((await call('POST', '/admin/login', { password: 'correct-horse' })).status).toBe(200);
    expect((await call('GET', '/admin/ledgers')).status).toBe(200);
  });

  it('hides the admin API when disabled', async () => {
    const { call } = setup({});
    expect((await call('GET', '/admin/ledgers')).status).toBe(404);
  });

  it('trusts the proxy header only at login, then only the admin session', async () => {
    const { call, login, config } = setup({ ADMIN_AUTH: 'proxy', ADMIN_EMAILS: 'me@example.com' });
    expect(await login('/x', { 'x-forwarded-email': 'evil@example.com' })).toMatchObject({ status: 302, location: '/admin?return_to=%2Fx&error=denied' });
    expect((await call('GET', '/admin/ledgers', undefined, { 'x-forwarded-email': 'me@example.com' })).status).toBe(401);
    expect(await login('/x', { 'x-forwarded-email': 'me@example.com' })).toMatchObject({ status: 302, location: '/x' });
    expect((await call('GET', '/session')).data.admin).toEqual({ name: 'me@example.com' });

    const ledger = (await call('POST', '/admin/ledgers', { name: '白名单' })).data;
    await call('POST', `/admin/ledgers/${ledger.id}/enter`);
    expect((await call('GET', '/ledger')).status).toBe(200);
    config.adminEmails = ['someone-else@example.com'];
    expect((await call('GET', '/admin/ledgers')).status).toBe(401);
    expect((await call('GET', '/ledger')).status).toBe(401);
    expect((await call('GET', '/session')).data).toEqual({ session: null, admin: null });
  });
});

describe('API (shared mode)', () => {
  it('lets everyone in without a passphrase', async () => {
    const { call } = setup({ MODE: 'shared' });
    const { session } = (await call('GET', '/session')).data;
    expect(session).toMatchObject({ role: 'shared', ledger: { id: 'shared' } });
    expect((await call('POST', '/ledger/changes', { changes: [{ op: 'member.create', id: newId(), member: { name: '室友' } }] })).status).toBe(200);
    expect((await call('POST', '/join', { code: 'abc' })).status).toBe(404);
  });
});
