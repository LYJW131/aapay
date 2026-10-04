import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { UpgradeWebSocket } from 'hono/ws';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { createNodePlatform } from '../src/server/node/platform.ts';
import type { AiRunner } from '../src/server/platform.ts';
import { RECOGNIZE_MODEL } from '../src/server/recognize.ts';

const dir = mkdtempSync(join(tmpdir(), 'aapay-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function setup(env: Record<string, string>, ai: AiRunner | null = null) {
  const config = loadConfig(env);
  const platform = createNodePlatform(join(dir, crypto.randomUUID()), (() => undefined) as unknown as UpgradeWebSocket, null, ai);
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
    expect((await call('GET', '/config')).data).toEqual({ mode: 'isolated', adminAuth: 'none', mcp: true, recognize: false });
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

    await call('DELETE', `/admin/passphrases/${phrase.id}`);
    expect((await call('GET', '/ledger')).status).toBe(401);

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

describe('API (bill recognition)', () => {
  const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const completion = (content: unknown) => ({ choices: [{ message: { content: JSON.stringify(content) } }] });

  async function joined(ai: AiRunner | null) {
    const api = setup({ ADMIN_AUTH: 'none' }, ai);
    const ledger = (await api.call('POST', '/admin/ledgers', { name: '识别测试' })).data;
    await api.call('POST', `/admin/ledgers/${ledger.id}/passphrases`, { code: 'scan2026', validUntil: null });
    api.resetCookies();
    expect((await api.call('POST', '/ledger/recognize', { image })).status).toBe(401);
    await api.call('POST', '/join', { code: 'scan2026' });
    return api;
  }

  it('turns the model reply into drafts in cents', async () => {
    const seen: { model: string; input: any }[] = [];
    const { call } = await joined(async (model, input) => {
      seen.push({ model, input });
      return completion({
        items: [
          { title: ' 鑫震源山塘街店 ', amount: -147, date: '2026-10-01' },
          { title: '滴滴出行', amount: 39.16, date: '2026-10-01' },
        ],
      });
    });
    expect((await call('GET', '/config')).data.recognize).toBe(true);
    const res = await call('POST', '/ledger/recognize', { image });
    expect(res).toEqual({
      status: 200,
      data: {
        items: [
          { title: '鑫震源山塘街店', amount: 14700, date: '2026-10-01' },
          { title: '滴滴出行', amount: 3916, date: '2026-10-01' },
        ],
      },
    });
    expect(seen[0]!.model).toBe(RECOGNIZE_MODEL);
    expect(seen[0]!.input.messages[1].content[0].image_url.url).toBe(image);
  });

  it('drops fields the model got wrong and rejects non-bills', async () => {
    let reply: unknown = completion({
      items: [
        { title: '外卖', amount: 0, date: '10月4日' },
        { title: null, amount: null, date: '2026-10-04' },
      ],
    });
    const { call } = await joined(async () => reply);
    expect((await call('POST', '/ledger/recognize', { image })).data).toEqual({
      items: [{ title: '外卖', amount: null, date: null }],
    });
    reply = completion({ items: [] });
    expect((await call('POST', '/ledger/recognize', { image })).status).toBe(422);
    reply = completion({ title: '旧格式', amount: 1, date: null });
    expect((await call('POST', '/ledger/recognize', { image })).status).toBe(502);
    reply = { choices: [{ message: { content: '我看不清' } }] };
    expect((await call('POST', '/ledger/recognize', { image })).status).toBe(502);
  });

  it('validates the image, reports model failures and limits the rate', async () => {
    const { call } = await joined(async () => {
      throw new Error('upstream down');
    });
    expect((await call('POST', '/ledger/recognize', { image: 'https://example.com/a.jpg' })).status).toBe(400);
    expect((await call('POST', '/ledger/recognize', { image })).status).toBe(502);
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await call('POST', '/ledger/recognize', { image })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it('is unavailable without an AI backend', async () => {
    const { call } = await joined(null);
    expect((await call('GET', '/config')).data.recognize).toBe(false);
    expect((await call('POST', '/ledger/recognize', { image })).status).toBe(404);
  });
});
