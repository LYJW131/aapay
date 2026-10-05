import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
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
    expect((await call('GET', '/config')).data).toEqual({ mode: 'isolated', adminAuth: 'none', mcp: true, recognize: false });
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

    const a = (await call('POST', '/ledger/members', { name: '阿杰' })).data.event.member;
    const b = (await call('POST', '/ledger/members', { name: '小雨' })).data.event.member;
    const bad = await call('POST', '/ledger/expenses', { title: '', amount: 1, payerId: a.id, date: '2026-10-01', participantIds: [a.id] });
    expect(bad).toEqual({ status: 400, data: { error: '用途不能为空' } });
    const english = { 'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8' };
    const badEn = await call('POST', '/ledger/expenses', { title: '', amount: 1, payerId: a.id, date: '2026-10-01', participantIds: [a.id] }, english);
    expect(badEn.data.error).toBe('Description is required');
    expect((await call('POST', '/ledger/members', { name: '阿杰' }, english)).data.error).toBe('A member named “阿杰” already exists');
    expect((await call('POST', '/ledger/members', { name: '阿杰' })).data.error).toBe('成员「阿杰」已存在');

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
    expect((await call('GET', '/session')).data.session).toBeNull();
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
    expect((await call('POST', '/ledger/members', { name: '室友' })).status).toBe(200);
    expect((await call('POST', '/join', { code: 'abc' })).status).toBe(404);
  });
});

describe('API (bill recognition)', () => {
  const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const completion = (content: unknown) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(content) }] } }] });
  afterEach(() => vi.unstubAllGlobals());

  function gemini(reply: (url: string, body: any) => unknown) {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => Response.json(await reply(url, JSON.parse(init.body as string))));
  }

  async function joined(env: Record<string, string> = { GEMINI_API_KEY: 'test-key' }) {
    const api = setup({ ADMIN_AUTH: 'none', ...env });
    await api.login();
    const ledger = (await api.call('POST', '/admin/ledgers', { name: '识别测试' })).data;
    await api.call('POST', `/admin/ledgers/${ledger.id}/passphrases`, { code: 'scan2026', validUntil: null });
    api.resetCookies();
    expect((await api.call('POST', '/ledger/recognize', { image })).status).toBe(401);
    await api.call('POST', '/join', { code: 'scan2026' });
    return api;
  }

  it('turns the model reply into drafts in cents', async () => {
    const seen: { url: string; body: any }[] = [];
    gemini((url, body) => {
      seen.push({ url, body });
      return completion({
        items: [
          { title: ' 鑫震源山塘街店 ', amount: -147, date: '2026-10-01' },
          { title: '滴滴出行', amount: 39.16, date: '2026-10-01' },
        ],
      });
    });
    const { call } = await joined();
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
    expect(seen[0]!.url).toContain('/models/gemini-flash-lite-latest:generateContent');
    expect(seen[0]!.body.contents[0].parts[0].inlineData).toEqual({ mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' });
  });

  it('uses DeepSeek when DEEPSEEK_API_KEY is set', async () => {
    const seen: { url: string; body: any; auth: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(init.body as string), auth: (init.headers as Record<string, string>).authorization! });
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ items: [{ title: '瑞幸咖啡', amount: 16.9, date: '2026-10-04' }] }) } }],
      });
    });
    const { call } = await joined({ DEEPSEEK_API_KEY: 'ds-key', GEMINI_API_KEY: 'test-key' });
    expect((await call('GET', '/config')).data.recognize).toBe(true);
    expect((await call('POST', '/ledger/recognize', { image })).data).toEqual({
      items: [{ title: '瑞幸咖啡', amount: 1690, date: '2026-10-04' }],
    });
    expect(seen[0]).toMatchObject({
      url: 'https://api.deepseek.com/chat/completions',
      auth: 'Bearer ds-key',
      body: { model: 'deepseek-flash', thinking: { type: 'disabled' }, response_format: { type: 'json_object' } },
    });
    expect(seen[0]!.body.messages[1].content[0].image_url.url).toBe(image);

    const other = await joined({ DEEPSEEK_API_KEY: 'ds-key', DEEPSEEK_MODEL: 'deepseek-v4-pro' });
    await other.call('POST', '/ledger/recognize', { image });
    expect(seen[1]!.body.model).toBe('deepseek-v4-pro');
  });

  it('drops fields the model got wrong and rejects non-bills', async () => {
    let reply: unknown = completion({
      items: [
        { title: '外卖', amount: 0, date: '10月4日' },
        { title: null, amount: null, date: '2026-10-04' },
      ],
    });
    let url = '';
    gemini((u) => {
      url = u;
      return reply;
    });
    const { call } = await joined({ GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-2.5-flash' });
    expect((await call('POST', '/ledger/recognize', { image })).data).toEqual({
      items: [{ title: '外卖', amount: null, date: null }],
    });
    expect(url).toContain('/models/gemini-2.5-flash:generateContent');
    reply = completion({ items: [] });
    expect((await call('POST', '/ledger/recognize', { image })).status).toBe(422);
    reply = completion({ title: '旧格式', amount: 1, date: null });
    expect((await call('POST', '/ledger/recognize', { image })).status).toBe(502);
    reply = { candidates: [{ content: { parts: [{ text: '我看不清' }] } }] };
    expect((await call('POST', '/ledger/recognize', { image })).status).toBe(502);
  });

  it('validates the image, reports model failures and limits the rate', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: { message: 'User location is not supported' } }, { status: 400 }));
    const { call } = await joined();
    expect((await call('POST', '/ledger/recognize', { image: 'https://example.com/a.jpg' })).status).toBe(400);
    expect((await call('POST', '/ledger/recognize', { image })).status).toBe(502);
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await call('POST', '/ledger/recognize', { image })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it('is unavailable without a Gemini API key', async () => {
    const { call } = await joined({});
    expect((await call('GET', '/config')).data.recognize).toBe(false);
    expect((await call('POST', '/ledger/recognize', { image })).status).toBe(404);
  });
});
