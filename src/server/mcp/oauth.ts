import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { passphraseCode } from '../../shared/schema.ts';
import type { AuthorizeInfo, McpScope } from '../../shared/types.ts';
import type { AppEnv } from '../app.ts';
import { SESSION_COOKIE } from '../auth/cookies.ts';
import { AppError, notFound } from '../core/errors.ts';
import { newId, newToken, sha256 } from '../core/ids.ts';
import { OAUTH_TTL, type GrantSource, type OAuthClient } from '../core/registry.ts';
import { clientIp, findSession } from '../session.ts';
import { body } from '../validate.ts';

/**
 * OAuth 2.1 授权服务器，按 MCP Authorization 规范实现：
 *   - RFC 9728 受保护资源元数据 / RFC 8414 授权服务器元数据
 *   - RFC 7591 动态客户端注册，以及 Client ID Metadata Document（client_id 即元数据 URL）
 *   - 授权码 + PKCE（仅 S256），RFC 8707 资源指示符把令牌绑定到 /mcp
 *   - 刷新令牌轮换、RFC 7009 令牌撤销、RFC 9207 iss 回传
 *
 * 「用户」即账本：授权页上输入分享口令（或沿用浏览器里已登录的账本），
 * 签发的令牌只能访问这一个账本，口令被撤销时一并失效。
 */

export const MCP_PATH = '/mcp';
export const SCOPES = ['ledger:read', 'ledger:write'] as const satisfies readonly McpScope[];
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;
const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

/** OAuth 协议错误：以 { error, error_description } 返回 */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    description: string,
    readonly status: 400 | 401 | 429 = 400,
  ) {
    super(description);
    this.name = 'OAuthError';
  }
}

// ---------- 地址 ----------

/** 对外地址：优先 PUBLIC_URL，否则按请求（含反向代理头）推断 */
export function baseUrl(c: Context<AppEnv>) {
  if (c.var.config.publicUrl) return c.var.config.publicUrl;
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.slice(0, -1);
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || url.host;
  return `${proto}://${host}`;
}

export const resourceUrl = (c: Context<AppEnv>) => baseUrl(c) + MCP_PATH;
export const resourceMetadataUrl = (c: Context<AppEnv>) => `${baseUrl(c)}/.well-known/oauth-protected-resource${MCP_PATH}`;

const stripSlash = (s: string) => s.replace(/\/+$/, '');

// ---------- 回调地址 ----------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:']);

/** https、回环地址上的 http，或原生应用的私有 scheme（RFC 8252） */
function isValidRedirect(uri: string) {
  const url = URL.parse(uri);
  if (!url || url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
  return !FORBIDDEN_SCHEMES.has(url.protocol);
}

/** 精确匹配；回环地址忽略端口（RFC 8252 §7.3） */
function matchRedirect(registered: readonly string[], requested: string) {
  if (registered.includes(requested)) return true;
  const req = URL.parse(requested);
  if (!req || req.protocol !== 'http:' || !LOOPBACK.has(req.hostname)) return false;
  return registered.some((r) => {
    const reg = URL.parse(r);
    return (
      reg?.protocol === 'http:' &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search
    );
  });
}

// ---------- 客户端 ----------

const httpUrl = z
  .string()
  .max(512)
  .refine((s) => /^https?:$/.test(URL.parse(s)?.protocol ?? ''));

const clientMetadata = z.looseObject({
  redirect_uris: z
    .array(z.string().max(512).refine(isValidRedirect, '回调地址必须是 https、回环地址或应用私有 scheme'))
    .min(1, '至少需要一个回调地址')
    .max(10),
  client_name: z.string().trim().max(100).optional().catch(undefined),
  client_uri: httpUrl.optional().catch(undefined),
  token_endpoint_auth_method: z.enum(AUTH_METHODS).optional(),
  grant_types: z
    .array(z.string())
    .optional()
    .refine((g) => !g || g.includes('authorization_code'), '必须支持 authorization_code'),
  response_types: z
    .array(z.string())
    .optional()
    .refine((r) => !r || r.includes('code'), '必须支持 code'),
});

/** Client ID Metadata Document：client_id 是一个 https URL，指向客户端自己托管的元数据 */
function isMetadataUrl(clientId: string) {
  const url = URL.parse(clientId);
  return (
    !!url &&
    url.protocol === 'https:' &&
    url.pathname !== '/' &&
    !url.hash &&
    !url.username &&
    !url.password &&
    // 不允许直接指向 IP 或本机，减小服务端请求伪造的风险
    !LOOPBACK.has(url.hostname) &&
    !/^[\d.]+$|^\[.*\]$/.test(url.hostname)
  );
}

async function fetchClientMetadata(clientId: string): Promise<OAuthClient> {
  const res = await fetch(clientId, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 16_384) throw new Error('元数据文档过大');
  const doc = clientMetadata.extend({ client_id: z.literal(clientId) }).parse(JSON.parse(text));
  const now = Date.now();
  return {
    id: clientId,
    kind: 'cimd',
    name: doc.client_name ?? null,
    uri: doc.client_uri ?? null,
    redirectUris: doc.redirect_uris,
    secretHash: null,
    createdAt: now,
    fetchedAt: now,
  };
}

async function findClient(c: Context<AppEnv>, clientId: string): Promise<OAuthClient | null> {
  const { registry } = c.var.platform;
  const cached = await registry.getClient(clientId);
  if (!isMetadataUrl(clientId)) return cached?.kind === 'dcr' ? cached : null;
  if (cached && Date.now() - (cached.fetchedAt ?? 0) < OAUTH_TTL.metadata) return cached;
  try {
    const client = await fetchClientMetadata(clientId);
    await registry.saveClient(client);
    return client;
  } catch (err) {
    // 刷新失败时沿用旧缓存，首次获取失败则视为无效客户端
    if (cached) return cached;
    console.warn(`获取客户端元数据失败 ${clientId}:`, (err as Error).message);
    return null;
  }
}

const hostOf = (uri: string | null | undefined) => (uri ? (URL.parse(uri)?.host ?? null) : null);

// ---------- 授权请求 ----------

interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  challenge: string;
  scopes: McpScope[];
  resource: string;
}

/** 在回调地址上附加参数（含 RFC 9207 的 iss，帮助客户端防御混淆攻击） */
function redirectWith(c: Context<AppEnv>, uri: string, params: Record<string, string | null>) {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  url.searchParams.set('iss', baseUrl(c));
  return url.href;
}

function parseScopes(raw: string | null): McpScope[] {
  const requested = new Set(raw?.split(' ').filter(Boolean));
  // 写权限隐含读权限；未声明或只有不认识的 scope 时授予全部
  if (requested.has('ledger:write')) requested.add('ledger:read');
  const scopes = SCOPES.filter((s) => requested.has(s));
  return scopes.length ? scopes : [...SCOPES];
}

/**
 * 校验授权请求。client_id / redirect_uri 无效时绝不能重定向（直接报错给用户看）；
 * 其余错误按 OAuth 规范带着 error 跳回客户端。
 */
async function parseAuthorize(
  c: Context<AppEnv>,
  params: URLSearchParams,
): Promise<{ request: AuthorizeRequest } | { redirect: string }> {
  const clientId = params.get('client_id');
  if (!clientId) throw new AppError(400, '授权请求缺少 client_id');
  const client = await findClient(c, clientId);
  if (!client) throw new AppError(400, '未知的客户端，请在 AI 应用中重新添加连接');

  const redirectUri = params.get('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null);
  if (!redirectUri || !matchRedirect(client.redirectUris, redirectUri)) {
    throw new AppError(400, '回调地址与客户端注册的不一致');
  }

  const state = params.get('state');
  const fail = (error: string, description: string) => ({
    redirect: redirectWith(c, redirectUri, { error, error_description: description, state }),
  });

  if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'only response_type=code is supported');
  const challenge = params.get('code_challenge');
  if (!challenge || !/^[\w-]{43}$/.test(challenge) || params.get('code_challenge_method') !== 'S256') {
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  const resource = params.get('resource');
  if (resource !== null && stripSlash(resource) !== resourceUrl(c)) {
    return fail('invalid_target', `resource must be ${resourceUrl(c)}`);
  }

  return {
    request: { client, redirectUri, state, challenge, scopes: parseScopes(params.get('scope')), resource: resourceUrl(c) },
  };
}

// ---------- 令牌端点 ----------

async function readForm(c: Context): Promise<URLSearchParams> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) {
    const json = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return new URLSearchParams(
      Object.entries(json).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v] as [string, string]] : [])),
    );
  }
  return new URLSearchParams(await c.req.text());
}

/** 支持 client_secret_basic / client_secret_post / none（公共客户端靠 PKCE 保护） */
async function authenticateClient(c: Context<AppEnv>, form: URLSearchParams): Promise<OAuthClient> {
  let id = form.get('client_id');
  let secret = form.get('client_secret');
  const basic = /^Basic\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  if (basic) {
    const decoded = atob(basic);
    const sep = decoded.indexOf(':');
    id = decodeURIComponent(decoded.slice(0, sep));
    secret = decodeURIComponent(decoded.slice(sep + 1));
  }
  if (!id) throw new OAuthError('invalid_client', 'client authentication required', 401);
  const client = await findClient(c, id);
  if (!client) throw new OAuthError('invalid_client', 'unknown client', 401);
  if (client.secretHash && (!secret || (await sha256(secret)) !== client.secretHash)) {
    throw new OAuthError('invalid_client', 'invalid client credentials', 401);
  }
  return client;
}

/** PKCE S256：BASE64URL(SHA-256(code_verifier)) */
async function s256(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

// ---------- 路由 ----------

export const requireMcp = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.config.mcp) throw notFound('MCP 未启用');
  await next();
});

/** 元数据、令牌与注册端点会被浏览器里的 MCP 客户端（如 Inspector）跨域调用；它们不使用 Cookie */
export const openCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'Mcp-Protocol-Version', 'Mcp-Session-Id', 'Last-Event-ID'],
  exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'],
  maxAge: 86_400,
});

function authorizationServerMetadata(c: Context<AppEnv>) {
  const base = baseUrl(c);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: GRANT_TYPES,
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: AUTH_METHODS,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: base,
  };
}

function protectedResourceMetadata(c: Context<AppEnv>) {
  return {
    resource: resourceUrl(c),
    authorization_servers: [baseUrl(c)],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'AAPay',
    resource_documentation: baseUrl(c),
  };
}

/** /.well-known/*：资源元数据同时提供根路径与按路径插入（RFC 9728 §3.1）两种位置 */
export const wellKnownRoutes = new Hono<AppEnv>()
  .use(openCors, requireMcp)
  .get('/oauth-protected-resource', (c) => c.json(protectedResourceMetadata(c)))
  .get(`/oauth-protected-resource${MCP_PATH}`, (c) => c.json(protectedResourceMetadata(c)))
  .get('/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(c)))
  .get(`/oauth-authorization-server${MCP_PATH}`, (c) => c.json(authorizationServerMetadata(c)));

/** /oauth/*：令牌、注册、撤销。授权页 /oauth/authorize 由前端渲染，中间件不能覆盖到它 */
export const oauthRoutes = new Hono<AppEnv>()
  .use('/register', openCors, requireMcp)
  .use('/token', openCors, requireMcp)
  .use('/revoke', openCors, requireMcp)
  .post('/register', async (c) => {
    if (!(await c.var.platform.rateLimit('join', clientIp(c)))) {
      throw new OAuthError('invalid_request', 'too many registrations, try again later', 429);
    }
    const parsed = clientMetadata.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const code = issue?.path[0] === 'redirect_uris' ? 'invalid_redirect_uri' : 'invalid_client_metadata';
      throw new OAuthError(code, issue?.message ?? 'invalid client metadata');
    }
    const meta = parsed.data;
    // RFC 7591：未声明时默认 client_secret_basic
    const method = meta.token_endpoint_auth_method ?? 'client_secret_basic';
    const secret = method === 'none' ? null : newToken();
    const now = Date.now();
    const client: OAuthClient = {
      id: newId(24),
      kind: 'dcr',
      name: meta.client_name || null,
      uri: meta.client_uri ?? null,
      redirectUris: meta.redirect_uris,
      secretHash: secret ? await sha256(secret) : null,
      createdAt: now,
      fetchedAt: null,
    };
    await c.var.platform.registry.saveClient(client);
    return c.json(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(now / 1000),
        ...(secret && { client_secret: secret, client_secret_expires_at: 0 }),
        client_name: client.name ?? undefined,
        client_uri: client.uri ?? undefined,
        redirect_uris: client.redirectUris,
        grant_types: GRANT_TYPES,
        response_types: ['code'],
        token_endpoint_auth_method: method,
        scope: SCOPES.join(' '),
      },
      201,
      NO_STORE,
    );
  })
  .post('/token', async (c) => {
    const { registry } = c.var.platform;
    const form = await readForm(c);
    const client = await authenticateClient(c, form);
    const access = newToken();
    const refresh = newToken();
    const tokens = { accessHash: await sha256(access), refreshHash: await sha256(refresh) };

    let issued;
    switch (form.get('grant_type')) {
      case 'authorization_code': {
        const code = form.get('code');
        const verifier = form.get('code_verifier');
        if (!code || !verifier) throw new OAuthError('invalid_request', 'code and code_verifier are required');
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_grant', 'malformed code_verifier');
        const resource = form.get('resource');
        issued = await registry.exchangeCode(
          {
            codeHash: await sha256(code),
            clientId: client.id,
            redirectUri: form.get('redirect_uri'),
            challenge: await s256(verifier),
            resource: resource === null ? null : stripSlash(resource),
          },
          tokens,
        );
        break;
      }
      case 'refresh_token': {
        const token = form.get('refresh_token');
        if (!token) throw new OAuthError('invalid_request', 'refresh_token is required');
        issued = await registry.refreshGrant(await sha256(token), client.id, tokens);
        break;
      }
      default:
        throw new OAuthError('unsupported_grant_type', 'supported: authorization_code, refresh_token');
    }
    if (!issued) throw new OAuthError('invalid_grant', 'the grant is invalid, expired or revoked');

    return c.json(
      {
        access_token: access,
        token_type: 'Bearer',
        expires_in: Math.round((issued.accessExpiresAt - Date.now()) / 1000),
        refresh_token: refresh,
        scope: issued.scope,
      },
      200,
      NO_STORE,
    );
  })
  .post('/revoke', async (c) => {
    const token = (await readForm(c)).get('token');
    if (token) await c.var.platform.registry.revokeToken(await sha256(token));
    // RFC 7009：无论令牌是否存在都返回 200
    return c.body(null, 200);
  });

const approveInput = z.object({
  /** 授权页地址上的原始查询串，服务端重新校验，不信任前端解析结果 */
  query: z.string().max(8192),
  /** 输入的分享口令；不填则使用当前浏览器已登录的账本 */
  code: passphraseCode.optional(),
  /** 是否允许修改账目 */
  write: z.boolean(),
});

/** /api/oauth/*：授权页使用的接口（同源、带 Cookie，受全局跨站写保护） */
export const authorizeRoutes = new Hono<AppEnv>()
  .use(requireMcp)
  .get('/authorize', async (c) => {
    const parsed = await parseAuthorize(c, new URL(c.req.url).searchParams);
    if ('redirect' in parsed) return c.json({ redirect: parsed.redirect });
    const { client, redirectUri, scopes, state } = parsed.request;
    return c.json({
      client: { name: client.name, host: hostOf(client.uri) ?? (client.kind === 'cimd' ? hostOf(client.id) : null) },
      redirectHost: hostOf(redirectUri) ?? redirectUri,
      scopes,
      session: await findSession(c),
      denyUrl: redirectWith(c, redirectUri, { error: 'access_denied', error_description: 'the user denied access', state }),
    } satisfies AuthorizeInfo);
  })
  .post('/authorize', body(approveInput), async (c) => {
    const { platform, config } = c.var;
    const input = c.req.valid('json');
    const parsed = await parseAuthorize(c, new URLSearchParams(input.query));
    if ('redirect' in parsed) return c.json({ redirect: parsed.redirect, ledger: null });
    const request = parsed.request;

    let source: GrantSource;
    if (config.mode === 'shared') {
      const session = (await findSession(c))!;
      source = { kind: 'ledger', ledgerId: session.ledger.id, subject: 'shared' };
    } else if (input.code) {
      if (!(await platform.rateLimit('join', clientIp(c)))) throw new AppError(429, '尝试过于频繁，请稍后再试');
      source = { kind: 'passphrase', code: input.code };
    } else {
      const token = getCookie(c, SESSION_COOKIE);
      if (!token) throw new AppError(401, '请输入账本口令');
      source = { kind: 'session', tokenHash: await sha256(token) };
    }

    const scopes = input.write ? request.scopes : request.scopes.filter((s) => s === 'ledger:read');
    if (!scopes.length) throw new AppError(400, '至少需要查看权限');
    const code = newToken();
    const ledger = await platform.registry.createAuthCode(source, {
      codeHash: await sha256(code),
      clientId: request.client.id,
      redirectUri: request.redirectUri,
      challenge: request.challenge,
      scope: scopes.join(' '),
      resource: request.resource,
    });
    return c.json({ redirect: redirectWith(c, request.redirectUri, { code, state: request.state }), ledger });
  });
