import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { z } from 'zod';
import { passphraseCode } from '../../shared/schema.ts';
import type { AuthorizeInfo, McpScope } from '../../shared/types.ts';
import type { AppEnv } from '../app.ts';
import { SESSION_COOKIE } from '../auth/cookies.ts';
import { AppError, notFound } from '../core/errors.ts';
import { newId } from '../../shared/ids.ts';
import { newToken, sha256 } from '../core/ids.ts';
import { OAUTH_TTL, type GrantSource, type IssuedGrant, type NewConnection, type OAuthClient } from '../core/registry.ts';
import { clientIp, findSession } from '../session.ts';
import { body } from '../validate.ts';

export const MCP_PATH = '/mcp';
export const SCOPES = ['ledger:read', 'ledger:write'] as const satisfies readonly McpScope[];
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic', 'private_key_jwt'] as const;
const ASSERTION_ALGS = ['RS256', 'PS256', 'ES256', 'EdDSA'];
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

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

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:']);

function isValidRedirect(uri: string) {
  const url = URL.parse(uri);
  if (!url || url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
  return !FORBIDDEN_SCHEMES.has(url.protocol);
}

// 回环地址忽略端口（RFC 8252 §7.3）
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

const httpUrl = z
  .string()
  .max(512)
  .refine((s) => /^https?:$/.test(URL.parse(s)?.protocol ?? ''));

const clientMetadata = z.looseObject({
  redirect_uris: z
    .array(z.string().max(512).refine(isValidRedirect, 'redirect_uris must use https, a loopback address or a private-use scheme'))
    .min(1, 'at least one redirect_uri is required')
    .max(10),
  client_name: z.string().trim().max(100).optional().catch(undefined),
  client_uri: httpUrl.optional().catch(undefined),
  // 不能用枚举：客户端声明的方式各异（如 ChatGPT 的 private_key_jwt），由 authPolicy 判断
  token_endpoint_auth_method: z.string().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional().catch(undefined),
  jwks_uri: z.string().max(512).optional(),
  grant_types: z
    .array(z.string())
    .optional()
    .refine((g) => !g || g.includes('authorization_code'), 'grant_types must include authorization_code'),
  response_types: z
    .array(z.string())
    .optional()
    .refine((r) => !r || r.includes('code'), 'response_types must include code'),
});

// 服务端会主动请求的地址：只允许 https 域名，不允许 IP 或本机，减小请求伪造风险
function isSafeRemoteUrl(value: string) {
  const url = URL.parse(value);
  return (
    !!url &&
    url.protocol === 'https:' &&
    !url.hash &&
    !url.username &&
    !url.password &&
    !LOOPBACK.has(url.hostname) &&
    !/^[\d.]+$|^\[.*\]$/.test(url.hostname)
  );
}

const isMetadataUrl = (clientId: string) => isSafeRemoteUrl(clientId) && URL.parse(clientId)!.pathname !== '/';

type ClientMetadata = z.infer<typeof clientMetadata>;

function authPolicy(meta: ClientMetadata, kind: 'dcr' | 'cimd') {
  // RFC 7591 的默认值是 client_secret_basic；CIMD 客户端无法持有我们签发的密钥，默认按公共客户端处理
  const declared = meta.token_endpoint_auth_method ?? (kind === 'dcr' ? 'client_secret_basic' : 'none');
  const methods = new Set([declared, ...(kind === 'cimd' ? (meta.token_endpoint_auth_methods_supported ?? []) : [])]);
  const jwksUri = methods.has('private_key_jwt') && meta.jwks_uri && isSafeRemoteUrl(meta.jwks_uri) ? meta.jwks_uri : null;
  const issueSecret = kind === 'dcr' && (declared === 'client_secret_basic' || declared === 'client_secret_post');
  const policy = { method: declared, publicAllowed: methods.has('none'), jwksUri, issueSecret };
  if (!policy.publicAllowed && !policy.jwksUri && !policy.issueSecret) {
    throw new OAuthError('invalid_client_metadata', `unsupported token_endpoint_auth_method: ${declared}`);
  }
  return policy;
}

async function fetchClientMetadata(clientId: string): Promise<OAuthClient> {
  // Workers 的 fetch 不支持 redirect: 'error'（直接抛错），用 manual 并拒绝非 200（含 3xx）
  const res = await fetch(clientId, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 16_384) throw new Error('元数据文档过大');
  const doc = clientMetadata.extend({ client_id: z.literal(clientId) }).parse(JSON.parse(text));
  const policy = authPolicy(doc, 'cimd');
  const now = Date.now();
  return {
    id: clientId,
    kind: 'cimd',
    name: doc.client_name ?? null,
    uri: doc.client_uri ?? null,
    redirectUris: doc.redirect_uris,
    secretHash: null,
    jwksUri: policy.jwksUri,
    publicAllowed: policy.publicAllowed,
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

interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  challenge: string;
  scopes: McpScope[];
  resource: string;
}

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

// client_id / redirect_uri 无效时绝不能重定向（防开放跳转），其余错误按规范带着 error 跳回客户端
async function parseAuthorize(
  c: Context<AppEnv>,
  params: URLSearchParams,
): Promise<{ request: AuthorizeRequest } | { redirect: string }> {
  const clientId = params.get('client_id');
  if (!clientId) throw new AppError(400, 'oauthMissingClientId');
  const client = await findClient(c, clientId);
  if (!client) throw new AppError(400, 'oauthUnknownClient');

  const redirectUri = params.get('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null);
  if (!redirectUri || !matchRedirect(client.redirectUris, redirectUri)) {
    throw new AppError(400, 'oauthRedirectMismatch');
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

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function verifyClientAssertion(c: Context<AppEnv>, client: OAuthClient, assertion: string) {
  if (!client.jwksUri) throw new OAuthError('invalid_client', 'client does not support private_key_jwt', 401);
  let jwks = jwksCache.get(client.jwksUri);
  if (!jwks) jwksCache.set(client.jwksUri, (jwks = createRemoteJWKSet(new URL(client.jwksUri), { timeoutDuration: 5000 })));
  try {
    await jwtVerify(assertion, jwks, {
      issuer: client.id,
      subject: client.id,
      audience: [`${baseUrl(c)}/oauth/token`, baseUrl(c)],
      algorithms: ASSERTION_ALGS,
      requiredClaims: ['exp'],
    });
  } catch (err) {
    console.warn(`客户端断言验证失败 ${client.id}:`, (err as Error).message);
    throw new OAuthError('invalid_client', 'invalid client assertion', 401);
  }
}

async function authenticateClient(c: Context<AppEnv>, form: URLSearchParams): Promise<OAuthClient> {
  let id = form.get('client_id');
  let secret = form.get('client_secret');
  const assertion = form.get('client_assertion');
  if (assertion) {
    if (form.get('client_assertion_type') !== JWT_BEARER) {
      throw new OAuthError('invalid_client', `client_assertion_type must be ${JWT_BEARER}`, 401);
    }
    // 断言里的 iss 即 client_id，请求可以不单独携带 client_id（RFC 7523）
    try {
      id ??= String(decodeJwt(assertion).iss ?? '') || null;
    } catch {
      throw new OAuthError('invalid_client', 'malformed client assertion', 401);
    }
  }
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
  if (assertion) {
    await verifyClientAssertion(c, client, assertion);
  } else if (client.secretHash) {
    if (!secret || (await sha256(secret)) !== client.secretHash) {
      throw new OAuthError('invalid_client', 'invalid client credentials', 401);
    }
  } else if (!client.publicAllowed) {
    throw new OAuthError('invalid_client', 'client authentication required', 401);
  }
  return client;
}

async function s256(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

export const requireMcp = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.config.mcp) throw notFound('mcpDisabled');
  await next();
});

// 浏览器里的 MCP 客户端（如 Inspector）会跨域调用；这些端点不使用 Cookie
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
    token_endpoint_auth_signing_alg_values_supported: ASSERTION_ALGS,
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

// 资源元数据同时提供根路径与按路径插入（RFC 9728 §3.1）两种位置
export const wellKnownRoutes = new Hono<AppEnv>()
  .use(openCors, requireMcp)
  .get('/oauth-protected-resource', (c) => c.json(protectedResourceMetadata(c)))
  .get(`/oauth-protected-resource${MCP_PATH}`, (c) => c.json(protectedResourceMetadata(c)))
  .get('/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(c)))
  .get(`/oauth-authorization-server${MCP_PATH}`, (c) => c.json(authorizationServerMetadata(c)));

// 中间件按具体路径挂载：/oauth/authorize 是前端页面，不能被拦截
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
    if (meta.token_endpoint_auth_method && !(AUTH_METHODS as readonly string[]).includes(meta.token_endpoint_auth_method)) {
      throw new OAuthError('invalid_client_metadata', `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}`);
    }
    if (meta.token_endpoint_auth_method === 'private_key_jwt' && !(meta.jwks_uri && isSafeRemoteUrl(meta.jwks_uri))) {
      throw new OAuthError('invalid_client_metadata', 'private_key_jwt requires an https jwks_uri');
    }
    const policy = authPolicy(meta, 'dcr');
    const secret = policy.issueSecret ? newToken() : null;
    const now = Date.now();
    const client: OAuthClient = {
      id: newId(24),
      kind: 'dcr',
      name: meta.client_name || null,
      uri: meta.client_uri ?? null,
      redirectUris: meta.redirect_uris,
      secretHash: secret ? await sha256(secret) : null,
      jwksUri: policy.jwksUri,
      publicAllowed: policy.publicAllowed,
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
        token_endpoint_auth_method: policy.method,
        ...(policy.jwksUri && { jwks_uri: policy.jwksUri }),
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

    let issued: IssuedGrant | null;
    let connection: NewConnection | null = null;
    switch (form.get('grant_type')) {
      case 'authorization_code': {
        const code = form.get('code');
        const verifier = form.get('code_verifier');
        if (!code || !verifier) throw new OAuthError('invalid_request', 'code and code_verifier are required');
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_grant', 'malformed code_verifier');
        const resource = form.get('resource');
        const exchanged = await registry.exchangeCode(
          {
            codeHash: await sha256(code),
            clientId: client.id,
            redirectUri: form.get('redirect_uri'),
            challenge: await s256(verifier),
            resource: resource === null ? null : stripSlash(resource),
          },
          tokens,
        );
        issued = exchanged;
        connection = exchanged?.connection ?? null;
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
    if (connection) {
      const { ledgerId, authorizer, client, host, scopes } = connection;
      await c.var.platform.ledger(ledgerId).api.record(authorizer, { type: 'connection.create', client, host, scopes });
    }

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
    const revoked = token ? await c.var.platform.registry.revokeToken(await sha256(token)) : null;
    if (revoked) {
      const { ledgerId, client, host, verified } = revoked;
      await c.var.platform.ledger(ledgerId).api.record({ kind: 'ai', client, host, verified }, { type: 'connection.revoke', client, host });
    }
    // RFC 7009：无论令牌是否存在都返回 200
    return c.body(null, 200);
  });

export const approveInput = z.object({
  // 服务端用原始查询串重新校验整个请求，不信任前端的解析结果
  query: z.string().max(8192),
  code: passphraseCode.optional(),
  write: z.boolean(),
});

export type ApproveInput = z.infer<typeof approveInput>;

export async function approveAuthorization(c: Context<AppEnv>, input: ApproveInput, admin: string | null) {
  const { platform, config } = c.var;
  const parsed = await parseAuthorize(c, new URLSearchParams(input.query));
  if ('redirect' in parsed) return { redirect: parsed.redirect, ledger: null };
  const request = parsed.request;

  let source: GrantSource;
  if (admin !== null) {
    source = { kind: 'admin', subject: admin };
  } else if (config.mode === 'shared') {
    const session = (await findSession(c))!;
    source = { kind: 'ledger', ledgerId: session.ledger.id, subject: 'shared' };
  } else if (input.code) {
    if (!(await platform.rateLimit('join', clientIp(c)))) throw new AppError(429, 'tooManyAttempts');
    source = { kind: 'passphrase', code: input.code };
  } else {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) throw new AppError(401, 'passphraseRequired');
    if (!(await findSession(c))) throw new AppError(401, 'ledgerSessionExpired');
    source = { kind: 'session', tokenHash: await sha256(token) };
  }

  const scopes = input.write ? request.scopes : request.scopes.filter((s) => s === 'ledger:read');
  if (!scopes.length) throw new AppError(400, 'oauthScopeRequired');
  const code = newToken();
  const ledger = await platform.registry.createAuthCode(source, {
    codeHash: await sha256(code),
    clientId: request.client.id,
    redirectUri: request.redirectUri,
    challenge: request.challenge,
    scope: scopes.join(' '),
    resource: request.resource,
  });
  return { redirect: redirectWith(c, request.redirectUri, { code, state: request.state }), ledger };
}

export const authorizeRoutes = new Hono<AppEnv>()
  .use(requireMcp)
  .get('/authorize', async (c) => {
    const parsed = await parseAuthorize(c, new URL(c.req.url).searchParams);
    if ('redirect' in parsed) return c.json({ redirect: parsed.redirect });
    const { client, redirectUri, scopes, state } = parsed.request;
    const { config } = c.var;
    const url = new URL(c.req.url);
    const canLogin = config.mode !== 'shared' && (config.adminAuth === 'access' || config.adminAuth === 'password');
    return c.json({
      client: { name: client.name, host: hostOf(client.uri) ?? (client.kind === 'cimd' ? hostOf(client.id) : null) },
      redirectHost: hostOf(redirectUri) ?? redirectUri,
      scopes,
      session: await findSession(c),
      adminLoginUrl: canLogin ? `/admin?return_to=${encodeURIComponent(`/oauth/authorize${url.search}`)}` : null,
      denyUrl: redirectWith(c, redirectUri, { error: 'access_denied', error_description: 'the user denied access', state }),
    } satisfies AuthorizeInfo);
  })
  .post('/authorize', body(approveInput), async (c) => c.json(await approveAuthorization(c, c.req.valid('json'), null)));
