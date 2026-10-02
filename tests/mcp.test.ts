import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpgradeWebSocket } from 'hono/ws';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
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
    }
    return { status: res.status, headers: res.headers, data };
  }

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

  async function connectAdmin(headers: Record<string, string> = {}, write = true) {
    const clientId = (await request('POST', '/oauth/register', {
      json: { client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
    })).data.client_id;
    const { verifier, challenge } = await pkce();
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` }).toString();
    const approved = await request('POST', '/api/admin/oauth/authorize', { json: { query, write }, headers });
    if (approved.status !== 200) return { status: approved.status, token: '', ledger: undefined };
    const code = new URL(approved.data.redirect).searchParams.get('code')!;
    const token = await request('POST', '/oauth/token', {
      form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier },
    });
    return { status: 200, token: token.data.access_token as string, ledger: approved.data.ledger };
  }

  return { request, connect, connectAdmin, rpc, tool, config, resetCookies: () => (cookies = new Map()) };
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

    const other = (await s.request('POST', '/oauth/register', { json: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } })).data;
    const stolen = await s.request('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: next.data.refresh_token, client_id: other.client_id } });
    expect(stolen.data.error).toBe('invalid_grant');

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

    const moved = 'https://moved.example.com/client.json';
    vi.stubGlobal('fetch', async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/client.json' } }));
    const redirected = await s.request('GET', `/api/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: moved, redirect_uri: 'https://moved.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' })}`);
    expect(redirected.status).toBe(400);

    const forged = 'https://evil.example.com/client.json';
    vi.stubGlobal('fetch', async () => Response.json({ client_id: clientId, redirect_uris: ['https://evil.example.com/cb'] }));
    const res = await s.request('GET', `/api/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: forged, redirect_uri: 'https://evil.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' })}`);
    expect(res.status).toBe(400);
  });
});

describe('private_key_jwt (ChatGPT-style client)', () => {
  const clientId = 'https://chat.example.com/oauth/client.json';
  const redirect = 'https://chat.example.com/connector_platform_oauth_redirect';

  async function setupClient(doc: Record<string, unknown>) {
    // 每个用例一个 JWKS 地址：jose 的远程 JWKS 在 30 秒冷却期内不会重复拉取
    const jwksUri = `https://chat.example.com/oauth/jwks-${crypto.randomUUID()}.json`;
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const kid = crypto.randomUUID();
    const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === clientId) {
        return Response.json({ client_id: clientId, client_name: 'ChatGPT', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], jwks_uri: jwksUri, token_endpoint_auth_signing_alg: 'RS256', ...doc });
      }
      if (url === jwksUri) return Response.json({ keys: [jwk] });
      return new Response('not found', { status: 404 });
    });
    const s = setup();
    await seedLedger(s, '出差', 'trip2026');
    const code = async () => {
      const { verifier, challenge } = await pkce();
      const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` }).toString();
      const res = await s.request('POST', '/api/oauth/authorize', { json: { query, code: 'trip2026', write: true } });
      return { code: new URL(res.data.redirect).searchParams.get('code')!, verifier };
    };
    const assertion = (key: CryptoKey = privateKey, aud = `${ORIGIN}/oauth/token`) =>
      new SignJWT({ jti: crypto.randomUUID() })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(clientId)
        .setSubject(clientId)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(key);
    const exchange = (grant: { code: string; verifier: string }, extra: Record<string, string>) =>
      s.request('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code: grant.code, redirect_uri: redirect, code_verifier: grant.verifier, ...extra } });
    return { s, code, assertion, exchange };
  }

  it('advertises private_key_jwt', async () => {
    const as = (await setup().request('GET', '/.well-known/oauth-authorization-server')).data;
    expect(as.token_endpoint_auth_methods_supported).toContain('private_key_jwt');
    expect(as.token_endpoint_auth_signing_alg_values_supported).toContain('RS256');
  });

  it('accepts a signed client assertion and also the public fallback', async () => {
    const { s, code, assertion, exchange } = await setupClient({ token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'] });
    const signed = await exchange(await code(), { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: await assertion() });
    expect(signed.status).toBe(200);
    expect((await s.rpc(signed.data.access_token, 'ping')).data.result).toEqual({});

    const grant = await code();
    const { privateKey: other } = await generateKeyPair('RS256');
    const forged = await exchange(grant, { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: await assertion(other) });
    expect(forged).toMatchObject({ status: 401, data: { error: 'invalid_client' } });
    const wrongAud = await exchange(grant, { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: await assertion(undefined, 'https://other.example') });
    expect(wrongAud.status).toBe(401);

    const pub = await exchange(grant, { client_id: clientId });
    expect(pub.status).toBe(200);
  });

  it('requires the assertion when the client only supports private_key_jwt', async () => {
    const { code, assertion, exchange } = await setupClient({ token_endpoint_auth_method: 'private_key_jwt' });
    const grant = await code();
    expect((await exchange(grant, { client_id: clientId })).data.error).toBe('invalid_client');
    const ok = await exchange(grant, { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: await assertion() });
    expect(ok.status).toBe(200);
  });
});

describe('admin connections', () => {
  it('manages every ledger with admin tools', async () => {
    const s = setup();
    await seedLedger(s, '周末露营', 'Camp2026');
    const admin = await s.connectAdmin();
    expect(admin).toMatchObject({ status: 200, ledger: null });
    const token = admin.token;

    const init = (await s.rpc(token, 'initialize', { protocolVersion: '2025-11-25' })).data.result;
    expect(init.instructions).toContain('管理员');
    const tools = (await s.rpc(token, 'tools/list')).data.result.tools as { name: string; inputSchema: { required?: string[] } }[];
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_ledgers', 'create_ledger', 'delete_ledger', 'create_passphrase', 'revoke_passphrase', 'get_ledger', 'add_expense']));
    expect(tools.find((t) => t.name === 'add_expense')!.inputSchema.required).toContain('ledger');

    const created = (await s.tool(token, 'create_ledger', { name: '公司团建', valid_days: 7 })).structuredContent;
    expect(created.created.name).toBe('公司团建');
    expect(created.passphrase).toMatchObject({ status: 'active', joinLink: expect.stringMatching(new RegExp(`^${ORIGIN}/join#`)) });

    expect((await s.tool(token, 'get_ledger')).isError).toBe(true);
    await s.tool(token, 'add_member', { ledger: '公司团建', name: '小李' });
    await s.tool(token, 'add_member', { ledger: '公司团建', name: '小王' });
    const expense = await s.tool(token, 'add_expense', { ledger: '公司团建', title: '聚餐', amount: 300, payer: '小李' });
    expect(expense.structuredContent.created.participants).toHaveLength(2);
    const missing = await s.tool(token, 'get_ledger', { ledger: '不存在' });
    expect(missing.content[0]!.text).toContain('现有账本');

    const listed = (await s.tool(token, 'list_ledgers')).structuredContent.ledgers;
    expect(listed.find((l: { name: string }) => l.name === '公司团建')).toMatchObject({ members: 2, expenses: 1, totalSpent: 300, activePassphrases: 1 });

    const phrase = (await s.tool(token, 'create_passphrase', { ledger: '周末露营', code: 'camp2027' })).structuredContent.created;
    expect(phrase.code).toBe('camp2027');
    expect((await s.tool(token, 'list_passphrases', { ledger: '周末露营' })).structuredContent.passphrases).toHaveLength(2);
    expect((await s.tool(token, 'revoke_passphrase', { ledger: '周末露营', code: 'CAMP2027' })).structuredContent.revoked).toBe('camp2027');
    expect((await s.request('POST', '/api/join', { json: { code: 'camp2027' } })).status).toBe(401);

    expect((await s.tool(token, 'rename_ledger', { ledger: '公司团建', name: '团建 2026' })).structuredContent.renamed.name).toBe('团建 2026');
    const wrong = await s.tool(token, 'delete_ledger', { ledger: '团建 2026', confirm_name: '团建' });
    expect(wrong.isError).toBe(true);
    expect((await s.tool(token, 'delete_ledger', { ledger: '团建 2026', confirm_name: '团建 2026' })).structuredContent.deleted.name).toBe('团建 2026');

    const connections = (await s.request('GET', '/api/admin/connections')).data;
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ clientName: 'Claude', subject: 'developer' });
    await s.request('DELETE', `/api/admin/connections/${connections[0].id}`);
    expect((await s.rpc(token, 'ping')).status).toBe(401);
  });

  it('keeps admin tools away from members and read-only admins', async () => {
    const s = setup();
    await seedLedger(s);
    const member = await s.connect({ code: 'Camp2026' });
    const names = (await s.rpc(member.access_token, 'tools/list')).data.result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain('list_ledgers');
    expect((await s.rpc(member.access_token, 'tools/call', { name: 'delete_ledger', arguments: {} })).data.error.code).toBe(-32602);

    const readOnly = await s.connectAdmin({}, false);
    const token = readOnly.token;
    const tools = (await s.rpc(token, 'tools/list')).data.result.tools.map((t: { name: string }) => t.name);
    expect(tools).toEqual(['list_ledgers', 'list_passphrases', 'get_ledger', 'list_transactions']);
    expect((await s.tool(token, 'create_ledger', { name: 'x' })).isError).toBe(true);
  });

  it('requires a verified admin and revokes tokens when the admin loses access', async () => {
    const s = setup({ ADMIN_AUTH: 'proxy', ADMIN_EMAILS: 'me@example.com' });
    expect((await s.connectAdmin()).status).toBe(401);
    expect((await s.connectAdmin({ 'x-forwarded-email': 'evil@example.com' })).status).toBe(401);
    const ok = await s.connectAdmin({ 'x-forwarded-email': 'me@example.com' });
    const token = ok.token;
    expect((await s.rpc(token, 'ping')).status).toBe(200);
    s.config.adminEmails = ['someone-else@example.com'];
    expect((await s.rpc(token, 'ping')).status).toBe(401);
  });

  it('ignores the email allowlist where the console does (none / password)', async () => {
    const s = setup({ ADMIN_AUTH: 'none', ADMIN_EMAILS: 'me@example.com' });
    const admin = await s.connectAdmin();
    expect((await s.rpc(admin.token, 'ping')).status).toBe(200);
    s.config.adminAuth = 'disabled';
    expect((await s.rpc(admin.token, 'ping')).status).toBe(401);
  });
});

describe('registry migration', () => {
  it('keeps existing member connections when admin grants are introduced', async () => {
    const { openSqlite } = await import('../src/server/node/sqlite.ts');
    const { migrate } = await import('../src/server/core/sql.ts');
    const { MIGRATIONS, RegistryService } = await import('../src/server/core/registry.ts');
    const { sha256 } = await import('../src/server/core/ids.ts');
    const db = openSqlite(join(dir, `${crypto.randomUUID()}.db`));
    migrate(db, MIGRATIONS.slice(0, 3));
    const now = Date.now();
    db.run('INSERT INTO ledgers (id, name, created_at) VALUES (?, ?, ?)', 'L1', '老账本', now);
    db.run("INSERT INTO oauth_clients (id, kind, name, redirect_uris, created_at, last_used_at) VALUES ('c1', 'dcr', 'Claude', '[]', ?, ?)", now, now);
    db.run(
      `INSERT INTO oauth_grants (id, client_id, ledger_id, scope, resource, refresh_hash, created_at, last_used_at, expires_at)
       VALUES ('g1', 'c1', 'L1', 'ledger:read ledger:write', 'http://aapay.test/mcp', 'r1', ?, ?, ?)`,
      now, now, now + 86_400_000,
    );
    db.run('INSERT INTO oauth_tokens (token_hash, grant_id, expires_at) VALUES (?, ?, ?)', await sha256('tok'), 'g1', now + 3_600_000);

    const registry = new RegistryService(db, () => undefined);
    expect(registry.resolveAccessToken(await sha256('tok'))).toMatchObject({ role: 'member', ledger: { id: 'L1', name: '老账本' }, clientName: 'Claude' });
    registry.deleteLedger('L1');
    expect(registry.resolveAccessToken(await sha256('tok'))).toBeNull();
    expect(db.all('SELECT * FROM oauth_tokens')).toHaveLength(0);
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
