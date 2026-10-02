import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpgradeWebSocket } from 'hono/ws';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { createNodePlatform } from '../src/server/node/platform.ts';

const dir = mkdtempSync(join(tmpdir(), 'aapay-mcp-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

const ORIGIN = 'http://aapay.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function b64url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64url');
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

function setup(env: Record<string, string> = { ADMIN_AUTH: 'none' }) {
  const config = loadConfig(env);
  const platform = createNodePlatform(join(dir, crypto.randomUUID()), (() => undefined) as unknown as UpgradeWebSocket);
  const app = createApp(async (c, next) => {
    c.set('config', config);
    c.set('platform', platform);
    await next();
  });
  let cookies = new Map<string, string>();

  async function request(method: string, path: string, init: { json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = {
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      ...init.headers,
    };
    let body: string | undefined;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    }
    const res = await app.request(ORIGIN + path, { method, headers, body });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair!.split('=');
      if (v) cookies.set(k!, v);
      else cookies.delete(k!);
    }
    const text = await res.text();
    let data: any = text || null;
    try {
      data = JSON.parse(text);
    } catch {
      // 非 JSON 响应保留原文
    }
    return { status: res.status, headers: res.headers, data };
  }

  /** 走一遍完整授权：注册（可选）→ 授权页 → 换取令牌 */
  async function connect(opts: { clientId?: string; code?: string; write?: boolean; scope?: string } = {}) {
    const clientId =
      opts.clientId ??
      (await request('POST', '/oauth/register', {
        json: { client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
      })).data.client_id;
    const { verifier, challenge } = await pkce();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${ORIGIN}/mcp`,
      ...(opts.scope && { scope: opts.scope }),
    }).toString();
    const approved = await request('POST', '/api/oauth/authorize', {
      json: { query, code: opts.code, write: opts.write ?? true },
    });
    expect(approved.status).toBe(200);
    const redirect = new URL(approved.data.redirect);
    expect(redirect.searchParams.get('state')).toBe('xyz');
    expect(redirect.searchParams.get('iss')).toBe(ORIGIN);
    const token = await request('POST', '/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        code: redirect.searchParams.get('code')!,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${ORIGIN}/mcp`,
      },
    });
    expect(token.status).toBe(200);
    return { clientId, ...token.data, code: redirect.searchParams.get('code')!, verifier } as {
      clientId: string;
      access_token: string;
      refresh_token: string;
      scope: string;
      code: string;
      verifier: string;
    };
  }

  let rpcId = 0;
  async function rpc(token: string, method: string, params?: unknown) {
    const res = await request('POST', '/mcp', {
      json: { jsonrpc: '2.0', id: ++rpcId, method, params },
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    });
    return res;
  }
  async function tool(token: string, name: string, args: unknown = {}) {
    const res = await rpc(token, 'tools/call', { name, arguments: args });
    expect(res.status).toBe(200);
    return res.data.result as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
  }

  return { request, connect, rpc, tool, resetCookies: () => (cookies = new Map()) };
}

async function seedLedger(s: ReturnType<typeof setup>, name = '周末露营', code = 'Camp2026') {
  const ledger = (await s.request('POST', '/api/admin/ledgers', { json: { name } })).data;
  const phrase = (await s.request('POST', `/api/admin/ledgers/${ledger.id}/passphrases`, { json: { code, validUntil: null } })).data;
  return { ledger, phrase };
}

describe('OAuth discovery', () => {
  const s = setup();

  it('publishes resource and authorization server metadata', async () => {
    const prm = await s.request('GET', '/.well-known/oauth-protected-resource/mcp');
    expect(prm.data).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    expect(prm.headers.get('access-control-allow-origin')).toBe('*');
    expect((await s.request('GET', '/.well-known/oauth-protected-resource')).data.resource).toBe(`${ORIGIN}/mcp`);

    const as = (await s.request('GET', '/.well-known/oauth-authorization-server')).data;
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    });
  });

  it('challenges unauthenticated MCP requests with the metadata location', async () => {
    const res = await s.request('POST', '/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await s.request('POST', '/mcp', { json: {}, headers: { authorization: 'Bearer nope' } });
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('tolerates a trailing slash and 404s unknown discovery documents', async () => {
    expect((await s.request('POST', '/mcp/', { json: {} })).status).toBe(401);
    expect((await s.request('GET', '/.well-known/oauth-protected-resource/mcp/')).data.resource).toBe(`${ORIGIN}/mcp`);
    const oidc = await s.request('GET', '/.well-known/openid-configuration');
    expect(oidc).toMatchObject({ status: 404, data: { error: 'not_found' } });
  });

  it('honours PUBLIC_URL behind a proxy', async () => {
    const p = setup({ PUBLIC_URL: 'https://pay.example.com/' });
    expect((await p.request('GET', '/.well-known/oauth-authorization-server')).data.issuer).toBe('https://pay.example.com');
  });

  it('leaves the authorization page to the frontend', async () => {
    // 这里没有托管静态资源，应落到 404，而不是被 OAuth 端点的中间件拦截
    const page = await s.request('GET', '/oauth/authorize?client_id=x');
    expect(page.status).toBe(404);
  });

  it('can be switched off', async () => {
    const off = setup({ MCP: 'disabled' });
    expect((await off.request('GET', '/.well-known/oauth-authorization-server')).status).toBe(404);
    expect((await off.request('POST', '/mcp', { json: {} })).status).toBe(404);
    expect((await off.request('GET', '/api/config')).data.mcp).toBe(false);
  });
});

describe('OAuth + MCP flow', () => {
  it('connects with a passphrase and drives the ledger through tools', async () => {
    const s = setup();
    const { ledger } = await seedLedger(s);
    const info = await s.request('GET', `/api/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: (await s.request('POST', '/oauth/register', { json: { client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } })).data.client_id,
      redirect_uri: REDIRECT,
      code_challenge: (await pkce()).challenge,
      code_challenge_method: 'S256',
    })}`);
    expect(info.data).toMatchObject({ client: { name: 'Claude' }, redirectHost: 'claude.ai', scopes: ['ledger:read', 'ledger:write'], session: null });

    const conn = await s.connect({ code: 'camp2026' });
    expect(conn.scope).toBe('ledger:read ledger:write');

    // 授权码只能用一次
    const replay = await s.request('POST', '/oauth/token', {
      form: { grant_type: 'authorization_code', code: conn.code, client_id: conn.clientId, code_verifier: conn.verifier },
    });
    expect(replay).toMatchObject({ status: 400, data: { error: 'invalid_grant' } });

    const init = await s.rpc(conn.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.data.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'aapay' }, capabilities: { tools: {} } });
    expect(init.data.result.instructions).toContain('周末露营');

    const notified = await s.request('POST', '/mcp', {
      json: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: { authorization: `Bearer ${conn.access_token}` },
    });
    expect(notified.status).toBe(202);

    const tools = (await s.rpc(conn.access_token, 'tools/list')).data.result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual([
      'get_ledger', 'list_transactions', 'add_expense', 'update_expense', 'delete_expense',
      'add_member', 'update_member', 'record_settlement', 'delete_settlement',
    ]);
    expect(tools[2].inputSchema).toMatchObject({ type: 'object', required: ['title', 'amount', 'payer'] });
    expect(tools[4].annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });

    await s.tool(conn.access_token, 'add_member', { name: '阿杰' });
    await s.tool(conn.access_token, 'add_member', { name: '小雨' });
    await s.tool(conn.access_token, 'add_member', { name: 'Tom' });

    const expense = await s.tool(conn.access_token, 'add_expense', { title: '营地', amount: 300, payer: '阿杰', date: '2026-10-01' });
    expect(expense.isError).toBeUndefined();
    expect(expense.structuredContent.created).toMatchObject({ amount: 300, payer: '阿杰', participants: [{ name: '阿杰', share: 100 }, { name: '小雨', share: 100 }, { name: 'Tom', share: 100 }] });
    await s.tool(conn.access_token, 'add_expense', { title: '烧烤', amount: 0.1, payer: 'tom', participants: ['小雨', 'Tom'], date: '2026-10-02' });

    const bad = await s.tool(conn.access_token, 'add_expense', { title: '奶茶', amount: 20, payer: '路人' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('现有成员：阿杰、小雨、Tom');
    expect((await s.tool(conn.access_token, 'add_expense', { title: '奶茶', amount: 1.234, payer: '阿杰' })).isError).toBe(true);

    const overview = (await s.tool(conn.access_token, 'get_ledger')).structuredContent;
    expect(overview.summary).toMatchObject({ expenseCount: 2, totalSpent: 300.1, firstDate: '2026-10-01', lastDate: '2026-10-02' });
    expect(overview.suggestedTransfers).toEqual([
      { from: '小雨', to: '阿杰', amount: 100.05 },
      { from: 'Tom', to: '阿杰', amount: 99.95 },
    ]);

    const settle = await s.tool(conn.access_token, 'record_settlement', { from: '小雨', to: '阿杰', amount: 100.05, note: '微信' });
    expect(settle.structuredContent.created).toMatchObject({ from: '小雨', to: '阿杰', amount: 100.05 });

    const listed = (await s.tool(conn.access_token, 'list_transactions', { member: '小雨', type: 'expense' })).structuredContent;
    expect(listed).toMatchObject({ matched: 2, totalSpent: 300.1, truncated: false });
    const camp = listed.items.find((i: { title: string }) => i.title === '营地');

    const updated = await s.tool(conn.access_token, 'update_expense', { id: camp.id, amount: 330, participants: ['阿杰', '小雨'] });
    expect(updated.structuredContent.after).toMatchObject({ amount: 330, participants: [{ share: 165 }, { share: 165 }] });
    expect((await s.tool(conn.access_token, 'delete_expense', { id: camp.id })).structuredContent.deleted.title).toBe('营地');
    expect((await s.tool(conn.access_token, 'delete_expense', { id: camp.id })).isError).toBe(true);

    // 变更带着 mcp:客户端名 的来源，网页端会提示「由 Claude 修改」
    s.resetCookies();
    await s.request('POST', '/api/join', { json: { code: 'Camp2026' } });
    const snapshot = (await s.request('GET', '/api/ledger')).data;
    expect(snapshot.ledger.id).toBe(ledger.id);
    expect(snapshot.expenses).toHaveLength(1);

    const unknown = await s.rpc(conn.access_token, 'tools/call', { name: 'nope', arguments: {} });
    expect(unknown.data.error.code).toBe(-32602);
    expect((await s.rpc(conn.access_token, 'bogus/method')).data.error.code).toBe(-32601);
  });

  it('rotates refresh tokens', async () => {
    const s = setup();
    await seedLedger(s, '合租', 'room302');
    const conn = await s.connect({ code: 'room302' });
    const refresh = (token: string) =>
      s.request('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: token, client_id: conn.clientId } });

    const next = await refresh(conn.refresh_token);
    expect(next.status).toBe(200);
    expect(next.headers.get('cache-control')).toBe('no-store');
    expect(next.data.refresh_token).not.toBe(conn.refresh_token);
    expect((await s.rpc(next.data.access_token, 'ping')).data.result).toEqual({});
    expect((await refresh(conn.refresh_token)).data.error).toBe('invalid_grant');

    // 其他客户端拿不走这个刷新令牌
    const other = (await s.request('POST', '/oauth/register', { json: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } })).data;
    const stolen = await s.request('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: next.data.refresh_token, client_id: other.client_id } });
    expect(stolen.data.error).toBe('invalid_grant');

    // 撤销刷新令牌会结束整个授权
    await s.request('POST', '/oauth/revoke', { form: { token: next.data.refresh_token } });
    expect((await s.rpc(next.data.access_token, 'ping')).status).toBe(401);
  });

  it('lets ledger members see and disconnect apps, and revoking the passphrase cuts access', async () => {
    const s = setup();
    const { ledger, phrase } = await seedLedger(s, '公司团建', 'team88');
    const a = await s.connect({ code: 'team88' });
    const b = await s.connect({ code: 'team88', write: false });

    s.resetCookies();
    await s.request('POST', '/api/join', { json: { code: 'team88' } });
    const list = (await s.request('GET', '/api/ledger/connections')).data;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ clientName: 'Claude', clientHost: 'claude.ai' });
    expect(list.map((c: { scopes: string[] }) => c.scopes.length).sort()).toEqual([1, 2]);

    // 只读授权：只能看到查询工具，写操作被拒绝
    const readOnly = (await s.rpc(b.access_token, 'tools/list')).data.result.tools;
    expect(readOnly.map((t: { name: string }) => t.name)).toEqual(['get_ledger', 'list_transactions']);
    expect((await s.tool(b.access_token, 'add_member', { name: '某人' })).isError).toBe(true);

    const target = list.find((c: { scopes: string[] }) => c.scopes.length === 1);
    expect((await s.request('DELETE', `/api/ledger/connections/${target.id}`)).status).toBe(200);
    expect((await s.rpc(b.access_token, 'ping')).status).toBe(401);

    const admin = (await s.request('GET', '/api/admin/ledgers')).data.find((l: { id: string }) => l.id === ledger.id);
    expect(admin.connections).toBe(1);

    await s.request('DELETE', `/api/admin/passphrases/${phrase.id}`);
    expect((await s.rpc(a.access_token, 'ping')).status).toBe(401);
  });

  it('authorizes with the ledger already open in the browser', async () => {
    const s = setup();
    await seedLedger(s, '家庭', 'home2026');
    s.resetCookies();
    await s.request('POST', '/api/join', { json: { code: 'home2026' } });
    const conn = await s.connect();
    const init = await s.rpc(conn.access_token, 'initialize', { protocolVersion: '2025-11-25' });
    expect(init.data.result.instructions).toContain('家庭');

    s.resetCookies();
    const query = new URLSearchParams({ response_type: 'code', client_id: conn.clientId, redirect_uri: REDIRECT, code_challenge: (await pkce()).challenge, code_challenge_method: 'S256' }).toString();
    expect((await s.request('POST', '/api/oauth/authorize', { json: { query, write: true } })).status).toBe(401);
  });
});

describe('OAuth request validation', () => {
  const s = setup();
  const register = async (meta: Record<string, unknown>) => s.request('POST', '/oauth/register', { json: meta });

  it('validates client registration', async () => {
    expect((await register({ redirect_uris: ['http://evil.example/cb'] })).data.error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: ['javascript:alert(1)'] })).data.error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: [REDIRECT], grant_types: ['client_credentials'] })).data.error).toBe('invalid_client_metadata');
    const native = await register({ redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/callback', 'http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' });
    expect(native.status).toBe(201);
    expect(native.data.client_secret).toBeUndefined();
  });

  it('refuses bad authorization requests without redirecting to unknown places', async () => {
    await seedLedger(s, '校验', 'check123');
    const client = (await register({ redirect_uris: [REDIRECT, 'http://127.0.0.1:3000/cb'], token_endpoint_auth_method: 'none' })).data;
    const { challenge } = await pkce();
    const authorize = (params: Record<string, string>) =>
      s.request('GET', `/api/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, code_challenge: challenge, code_challenge_method: 'S256', ...params })}`);

    expect((await authorize({ client_id: 'unknown', redirect_uri: REDIRECT })).status).toBe(400);
    expect((await authorize({ redirect_uri: 'https://evil.example/cb' })).status).toBe(400);
    // 回环地址允许任意端口（RFC 8252）
    expect((await authorize({ redirect_uri: 'http://127.0.0.1:51234/cb' })).data.redirectHost).toBe('127.0.0.1:51234');

    const noPkce = await authorize({ redirect_uri: REDIRECT, code_challenge_method: 'plain' });
    expect(new URL(noPkce.data.redirect).searchParams.get('error')).toBe('invalid_request');
    const wrongResource = await authorize({ redirect_uri: REDIRECT, resource: 'https://other.example/mcp' });
    expect(new URL(wrongResource.data.redirect).searchParams.get('error')).toBe('invalid_target');

    const ok = await authorize({ redirect_uri: REDIRECT, state: 's1' });
    const deny = new URL(ok.data.denyUrl);
    expect(deny.searchParams.get('error')).toBe('access_denied');
    expect(deny.searchParams.get('state')).toBe('s1');
  });

  it('rejects a wrong PKCE verifier', async () => {
    const client = (await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })).data;
    const { challenge } = await pkce();
    const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    const code = new URL((await s.request('POST', '/api/oauth/authorize', { json: { query, code: 'check123', write: true } })).data.redirect).searchParams.get('code')!;
    const res = await s.request('POST', '/oauth/token', {
      form: { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: (await pkce()).verifier },
    });
    expect(res.data.error).toBe('invalid_grant');
  });

  it('authenticates confidential clients', async () => {
    const client = (await register({ client_name: 'ChatGPT', redirect_uris: [REDIRECT] })).data;
    expect(client.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(client.client_secret).toBeTruthy();
    const conn = await s.connect({ clientId: client.client_id, code: 'check123' }).catch((e: unknown) => e);
    // 没带 client_secret 的令牌请求会被拒绝
    expect(conn).toBeInstanceOf(Error);

    const basic = `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}`;
    const { verifier, challenge } = await pkce();
    const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    const code = new URL((await s.request('POST', '/api/oauth/authorize', { json: { query, code: 'check123', write: true } })).data.redirect).searchParams.get('code')!;
    const wrong = await s.request('POST', '/oauth/token', {
      form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier },
      headers: { authorization: `Basic ${btoa(`${client.client_id}:wrong`)}` },
    });
    expect(wrong).toMatchObject({ status: 401, data: { error: 'invalid_client' } });
    // 上面失败的请求没有消耗授权码
    const ok = await s.request('POST', '/oauth/token', {
      form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier },
      headers: { authorization: basic },
    });
    expect(ok.status).toBe(200);
  });

  it('supports client ID metadata documents', async () => {
    const clientId = 'https://app.example.com/oauth/client.json';
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      // 与 Cloudflare Workers 行为一致：不支持 redirect: 'error'
      if (init?.redirect === 'error') throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
      return Response.json({ client_id: clientId, client_name: 'Example AI', client_uri: 'https://app.example.com', redirect_uris: ['https://app.example.com/callback'] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { challenge } = await pkce();
    const info = await s.request('GET', `/api/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://app.example.com/callback', code_challenge: challenge, code_challenge_method: 'S256' })}`);
    expect(info.data).toMatchObject({ client: { name: 'Example AI', host: 'app.example.com' }, redirectHost: 'app.example.com' });
    expect(fetchMock).toHaveBeenCalledOnce();

    // 元数据 URL 发生跳转时不跟随
    const moved = 'https://moved.example.com/client.json';
    vi.stubGlobal('fetch', async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/client.json' } }));
    const redirected = await s.request('GET', `/api/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: moved, redirect_uri: 'https://moved.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' })}`);
    expect(redirected.status).toBe(400);

    // 文档里的 client_id 必须与 URL 一致
    const forged = 'https://evil.example.com/client.json';
    vi.stubGlobal('fetch', async () => Response.json({ client_id: clientId, redirect_uris: ['https://evil.example.com/cb'] }));
    const res = await s.request('GET', `/api/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: forged, redirect_uri: 'https://evil.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' })}`);
    expect(res.status).toBe(400);
  });
});

describe('MCP in shared mode', () => {
  it('authorizes the public ledger without a passphrase', async () => {
    const s = setup({ MODE: 'shared' });
    const conn = await s.connect();
    expect((await s.tool(conn.access_token, 'add_member', { name: '室友' })).structuredContent.created.name).toBe('室友');
    expect((await s.tool(conn.access_token, 'get_ledger')).structuredContent.ledger).toBe('共享账本');
  });
});
