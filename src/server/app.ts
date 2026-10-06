import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { changesInput, joinInput, ledgerInput, loginInput, passphraseInput, recognizeInput } from '../shared/schema.ts';
import { translateError } from '../shared/errors.ts';
import { localPath } from '../shared/redirect.ts';
import type { AdminIdentity, LedgerOverview, PublicConfig, SessionInfo, SessionState, Snapshot } from '../shared/types.ts';
import { adminActions } from './admin.ts';
import { authenticateAdmin, externalAdmin, passwordMatches } from './auth/admin.ts';
import { clearSessionCookie, CONSOLE_COOKIE, SESSION_COOKIE, setSessionCookie } from './auth/cookies.ts';
import { todayIn, type Config } from './config.ts';
import { AppError, notFound, unauthorized } from './core/errors.ts';
import { newToken, sha256 } from './core/ids.ts';
import {
  approveAuthorization,
  approveInput,
  authorizeRoutes,
  OAuthError,
  oauthRoutes,
  requireMcp,
  wellKnownRoutes,
} from './mcp/oauth.ts';
import { mcpRoutes } from './mcp/server.ts';
import type { Platform } from './platform.ts';
import { recognizeBills } from './recognize.ts';
import { actorOf, clientIp, findSession } from './session.ts';
import { body, localeOf, query } from './validate.ts';

const cursor = z.coerce.number().int().nonnegative().optional();
const auditQuery = z.object({ before: cursor, after: cursor, limit: z.coerce.number().int().min(1).max(500).default(50) });

export type AppEnv = {
  Variables: {
    platform: Platform;
    config: Config;
    session: SessionInfo;
    admin: AdminIdentity;
    consoleHash: string;
  };
};

const mutation = (c: Context<AppEnv>) => ({ actor: actorOf(c.var.session), origin: c.req.header('x-client-id')?.slice(0, 64) });

function requireUpgrade(c: Context) {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    throw new HTTPException(426, { message: 'Expected WebSocket upgrade' });
  }
}

const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const session = await findSession(c);
  if (!session) throw unauthorized();
  c.set('session', session);
  await next();
});

const admin = (c: Context<AppEnv>) => adminActions(c.var.platform, { kind: 'admin', name: c.var.admin.name });

const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const admin = await authenticateAdmin(c, c.var.config, c.var.platform);
  if (!admin) throw new AppError(c.var.config.adminAuth === 'disabled' ? 404 : 401, 'adminSessionInvalid');
  c.set('admin', admin.identity);
  c.set('consoleHash', admin.consoleHash);
  await next();
});

async function openConsole(c: Context<AppEnv>, subject: string) {
  const token = newToken();
  const expiresAt = await c.var.platform.registry.openConsoleSession(await sha256(token), subject);
  setSessionCookie(c, CONSOLE_COOKIE, token, expiresAt);
}

const ledgerRoutes = new Hono<AppEnv>()
  .use(requireSession)
  .get('/', async (c) => {
    const { ledger } = c.var.session;
    const data = await c.var.platform.ledger(ledger.id).api.snapshot();
    return c.json({ ...data, ledger } satisfies Snapshot);
  })
  .get('/live', (c) => {
    requireUpgrade(c);
    const { ledger, role, passphrase } = c.var.session;
    const tag = passphrase ? `p:${passphrase.toLowerCase()}` : role;
    return c.var.platform.ledger(ledger.id).connect(c, tag);
  })
  .post('/changes', body(changesInput), async (c) => {
    const { changes, via } = c.req.valid('json');
    return c.json(await c.var.platform.ledger(c.var.session.ledger.id).api.applyChanges(changes, { ...mutation(c), via }));
  })
  .post('/recognize', body(recognizeInput), async (c) => {
    const { platform, config, session } = c.var;
    if (!config.recognizer) throw notFound('recognizeDisabled');
    if (!(await platform.rateLimit('recognize', session.ledger.id))) throw new AppError(429, 'recognizeRateLimited');
    return c.json(await recognizeBills(config.recognizer, c.req.valid('json').image, todayIn(config.timezone), localeOf(c)));
  })
  .get('/audit', query(auditQuery), async (c) =>
    c.json(await c.var.platform.ledger(c.var.session.ledger.id).api.auditLog(c.req.valid('query'))),
  )
  .get('/connections', async (c) => c.json(await c.var.platform.registry.listConnections(c.var.session.ledger.id)))
  .delete('/connections/:id', async (c) => {
    const { platform, session } = c.var;
    const revoked = await platform.registry.revokeConnection(c.req.param('id'), session.ledger.id);
    await platform.ledger(session.ledger.id).api.record(actorOf(session), { type: 'connection.revoke', client: revoked.client, host: revoked.host });
    return c.json({ ok: true });
  });

// Access / 上游代理只拦截这一个整页跳转的地址：外部身份在这里换成本站的管理员会话，其余管理接口只认会话，过期时返回 401 而不是被边缘重定向
const adminRoutes = new Hono<AppEnv>()
  .get('/login', query(z.object({ return_to: z.string().optional() })), async (c) => {
    const { config } = c.var;
    const back = localPath(c.req.valid('query').return_to);
    const page = (extra = '') => c.redirect(`/admin?return_to=${encodeURIComponent(back)}${extra}`);
    if (config.adminAuth === 'password' || config.adminAuth === 'disabled') return page();
    const subject = await externalAdmin(c, config);
    if (!subject) return page('&error=denied');
    await openConsole(c, subject);
    return c.redirect(back);
  })
  .post('/login', body(loginInput), async (c) => {
    const { config, platform } = c.var;
    if (config.adminAuth !== 'password') throw notFound('passwordLoginDisabled');
    if (!(await platform.rateLimit('login', clientIp(c)))) throw new AppError(429, 'tooManyAttempts');
    if (!(await passwordMatches(c.req.valid('json').password, config.adminPassword))) {
      throw new AppError(401, 'wrongPassword');
    }
    await openConsole(c, 'admin');
    return c.json({ name: 'admin' } satisfies AdminIdentity);
  })
  .post('/logout', async (c) => {
    const token = getCookie(c, CONSOLE_COOKIE);
    if (token) await c.var.platform.registry.endSession(await sha256(token));
    clearSessionCookie(c, CONSOLE_COOKIE);
    return c.json({ ok: true });
  })
  .use(requireAdmin)
  .post('/oauth/authorize', requireMcp, body(approveInput), async (c) =>
    c.json(await approveAuthorization(c, c.req.valid('json'), c.var.admin.name)),
  )
  .get('/live', (c) => {
    requireUpgrade(c);
    return c.var.platform.connectConsole(c);
  })
  .get('/ledgers', async (c) => c.json((await admin(c).listLedgers()) satisfies LedgerOverview[]))
  .post('/ledgers', body(ledgerInput), async (c) =>
    c.json(await admin(c).createLedger(c.req.valid('json'))),
  )
  .patch('/ledgers/:id', body(ledgerInput), async (c) =>
    c.json(await admin(c).updateLedger(c.req.param('id'), c.req.valid('json'))),
  )
  .delete('/ledgers/:id', async (c) => c.json(await admin(c).deleteLedger(c.req.param('id'))))
  .get('/ledgers/:id/passphrases', async (c) =>
    c.json(await c.var.platform.registry.listPassphrases(c.req.param('id'))),
  )
  .post('/ledgers/:id/passphrases', body(passphraseInput), async (c) =>
    c.json(await admin(c).createPassphrase(c.req.param('id'), c.req.valid('json'))),
  )
  .delete('/passphrases/:id', async (c) => c.json(await admin(c).revokePassphrase(c.req.param('id'))))
  .get('/connections', async (c) => c.json(await c.var.platform.registry.listAdminConnections()))
  .delete('/connections/:id', async (c) => {
    await c.var.platform.registry.revokeAdminConnection(c.req.param('id'));
    return c.json({ ok: true });
  })
  .post('/ledgers/:id/enter', async (c) => {
    const token = newToken();
    const session = await c.var.platform.registry.openLedgerSession(await sha256(token), c.req.param('id'), c.var.consoleHash);
    setSessionCookie(c, SESSION_COOKIE, token, session.expiresAt!);
    return c.json(session);
  });

function buildApi() {
  return new Hono<AppEnv>()
    .get('/config', (c) =>
      c.json({
        mode: c.var.config.mode,
        adminAuth: c.var.config.adminAuth,
        mcp: c.var.config.mcp,
        assistant: c.var.config.recognizer !== null,
      } satisfies PublicConfig),
    )
    .get('/session', async (c) => {
      const admin = await authenticateAdmin(c, c.var.config, c.var.platform);
      return c.json({ session: await findSession(c), admin: admin?.identity ?? null } satisfies SessionState);
    })
    .post('/join', body(joinInput), async (c) => {
      const { platform, config } = c.var;
      if (config.mode === 'shared') throw notFound('sharedModeNoPassphrase');
      if (!(await platform.rateLimit('join', clientIp(c)))) throw new AppError(429, 'tooManyAttempts');
      const token = newToken();
      const session = await platform.registry.join(c.req.valid('json').code, await sha256(token));
      setSessionCookie(c, SESSION_COOKIE, token, session.expiresAt!);
      return c.json(session);
    })
    .post('/logout', async (c) => {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) await c.var.platform.registry.endSession(await sha256(token));
      clearSessionCookie(c, SESSION_COOKIE);
      return c.json({ ok: true });
    })
    .route('/ledger', ledgerRoutes)
    .route('/admin', adminRoutes)
    .route('/oauth', authorizeRoutes);
}

export type ApiType = ReturnType<typeof buildApi>;

// 需与 wrangler.jsonc 的 assets.run_worker_first 保持一致，否则 Cloudflare 上会被 SPA 回退接走
export const SERVER_PATHS = ['/api/*', '/mcp', '/mcp/*', '/oauth/token', '/oauth/register', '/oauth/revoke', '/.well-known/*'];

export function createApp(inject: MiddlewareHandler<AppEnv>) {
  // 不区分结尾斜杠：用户粘贴 https://…/mcp/ 也能连上
  const app = new Hono<AppEnv>({ strict: false });
  app.use('/api/*', async (c, next) => {
    // 只比较主机名：反向代理终止 TLS 后协议可能不同
    const origin = c.req.header('origin');
    const host = c.req.header('x-forwarded-host') ?? new URL(c.req.url).host;
    if (c.req.method !== 'GET' && origin && URL.parse(origin)?.host !== host) {
      return c.json({ error: translateError(localeOf(c), 'crossSiteRejected') }, 403);
    }
    await next();
  });
  for (const path of SERVER_PATHS) app.use(path, inject);
  app.route('/api', buildApi());
  app.all('/api/*', (c) => c.json({ error: translateError(localeOf(c), 'apiNotFound') }, 404));
  // MCP 与 OAuth 端点面向 AI 应用，不走 Cookie，不能挂在上面的同源写保护之下
  app.route('/mcp', mcpRoutes);
  app.route('/oauth', oauthRoutes);
  app.route('/.well-known', wellKnownRoutes);
  // 未实现的发现文档（如 openid-configuration）必须明确 404，不能落到前端页面
  app.all('/.well-known/*', (c) => c.json({ error: 'not_found' }, 404));
  app.all('/mcp/*', (c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    if (err instanceof OAuthError) {
      if (err.status === 401) c.header('WWW-Authenticate', 'Basic realm="aapay"');
      return c.json({ error: err.code, error_description: err.message }, err.status, { 'Cache-Control': 'no-store' });
    }
    if (err instanceof AppError) return c.json({ error: err.localized(localeOf(c)) }, err.status);
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: translateError(localeOf(c), 'internalError') }, 500);
  });
  return app;
}

