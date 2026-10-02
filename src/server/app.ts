import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import {
  expenseInput,
  joinInput,
  ledgerInput,
  loginInput,
  memberInput,
  passphraseInput,
  settlementInput,
} from '../shared/schema.ts';
import type { AdminIdentity, LedgerOverview, PublicConfig, SessionInfo, Snapshot } from '../shared/types.ts';
import { adminActions } from './admin.ts';
import { authenticateAdmin, passwordMatches } from './auth/admin.ts';
import { clearSessionCookie, CONSOLE_COOKIE, SESSION_COOKIE, setSessionCookie } from './auth/cookies.ts';
import type { Config } from './config.ts';
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
import { clientIp, findSession } from './session.ts';
import { body } from './validate.ts';

export type AppEnv = {
  Variables: {
    platform: Platform;
    config: Config;
    session: SessionInfo;
    admin: AdminIdentity;
  };
};

const originOf = (c: Context) => c.req.header('x-client-id')?.slice(0, 64);

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

const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const admin = await authenticateAdmin(c, c.var.config, c.var.platform);
  if (!admin) throw new AppError(c.var.config.adminAuth === 'disabled' ? 404 : 401, '需要管理员身份');
  c.set('admin', admin);
  await next();
});

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
  .post('/members', body(memberInput), async (c) =>
    c.json(await c.var.platform.ledger(c.var.session.ledger.id).api.createMember(c.req.valid('json'), originOf(c))),
  )
  .patch('/members/:id', body(memberInput), async (c) =>
    c.json(
      await c.var.platform
        .ledger(c.var.session.ledger.id)
        .api.updateMember(c.req.param('id'), c.req.valid('json'), originOf(c)),
    ),
  )
  .delete('/members/:id', async (c) =>
    c.json(await c.var.platform.ledger(c.var.session.ledger.id).api.deleteMember(c.req.param('id'), originOf(c))),
  )
  .post('/expenses', body(expenseInput), async (c) =>
    c.json(await c.var.platform.ledger(c.var.session.ledger.id).api.createExpense(c.req.valid('json'), originOf(c))),
  )
  .patch('/expenses/:id', body(expenseInput), async (c) =>
    c.json(
      await c.var.platform
        .ledger(c.var.session.ledger.id)
        .api.updateExpense(c.req.param('id'), c.req.valid('json'), originOf(c)),
    ),
  )
  .delete('/expenses/:id', async (c) =>
    c.json(await c.var.platform.ledger(c.var.session.ledger.id).api.deleteExpense(c.req.param('id'), originOf(c))),
  )
  .post('/settlements', body(settlementInput), async (c) =>
    c.json(
      await c.var.platform.ledger(c.var.session.ledger.id).api.createSettlement(c.req.valid('json'), originOf(c)),
    ),
  )
  .delete('/settlements/:id', async (c) =>
    c.json(
      await c.var.platform.ledger(c.var.session.ledger.id).api.deleteSettlement(c.req.param('id'), originOf(c)),
    ),
  )
  // 已通过 MCP 连接到本账本的 AI 应用，成员可以随时断开
  .get('/connections', async (c) => c.json(await c.var.platform.registry.listConnections(c.var.session.ledger.id)))
  .delete('/connections/:id', async (c) => {
    await c.var.platform.registry.revokeConnection(c.req.param('id'), c.var.session.ledger.id);
    return c.json({ ok: true });
  });

const adminRoutes = new Hono<AppEnv>()
  // 密码模式的登录入口本身不需要管理员身份
  .post('/login', body(loginInput), async (c) => {
    const { config, platform } = c.var;
    if (config.adminAuth !== 'password') throw notFound('当前未启用密码登录');
    if (!(await platform.rateLimit('login', clientIp(c)))) throw new AppError(429, '尝试过于频繁，请稍后再试');
    if (!(await passwordMatches(c.req.valid('json').password, config.adminPassword))) {
      throw new AppError(401, '密码错误');
    }
    const token = newToken();
    const expiresAt = await platform.registry.openConsoleSession(await sha256(token), 'admin');
    setSessionCookie(c, CONSOLE_COOKIE, token, expiresAt);
    return c.json({ name: 'admin', method: 'password' } satisfies AdminIdentity);
  })
  .post('/logout', async (c) => {
    const token = getCookie(c, CONSOLE_COOKIE);
    if (token) await c.var.platform.registry.endSession(await sha256(token));
    clearSessionCookie(c, CONSOLE_COOKIE);
    return c.json({ ok: true });
  })
  .use(requireAdmin)
  .get('/me', (c) => c.json(c.var.admin))
  // 以管理员身份授权 AI 应用管理全部账本（授权页调用）
  .post('/oauth/authorize', requireMcp, body(approveInput), async (c) =>
    c.json(await approveAuthorization(c, c.req.valid('json'), c.var.admin.name)),
  )
  .get('/live', (c) => {
    requireUpgrade(c);
    return c.var.platform.connectConsole(c);
  })
  .get('/ledgers', async (c) => c.json((await adminActions(c.var.platform).listLedgers()) satisfies LedgerOverview[]))
  .post('/ledgers', body(ledgerInput), async (c) =>
    c.json(await c.var.platform.registry.createLedger(c.req.valid('json').name)),
  )
  .patch('/ledgers/:id', body(ledgerInput), async (c) =>
    c.json(await adminActions(c.var.platform).renameLedger(c.req.param('id'), c.req.valid('json').name)),
  )
  .delete('/ledgers/:id', async (c) => c.json(await adminActions(c.var.platform).deleteLedger(c.req.param('id'))))
  .get('/ledgers/:id/passphrases', async (c) =>
    c.json(await c.var.platform.registry.listPassphrases(c.req.param('id'))),
  )
  .post('/ledgers/:id/passphrases', body(passphraseInput), async (c) =>
    c.json(await c.var.platform.registry.createPassphrase(c.req.param('id'), c.req.valid('json'))),
  )
  .delete('/passphrases/:id', async (c) => c.json(await adminActions(c.var.platform).revokePassphrase(c.req.param('id'))))
  // 以管理员身份连接的 AI 应用
  .get('/connections', async (c) => c.json(await c.var.platform.registry.listAdminConnections()))
  .delete('/connections/:id', async (c) => {
    await c.var.platform.registry.revokeAdminConnection(c.req.param('id'));
    return c.json({ ok: true });
  })
  .post('/ledgers/:id/enter', async (c) => {
    const token = newToken();
    const session = await c.var.platform.registry.openLedgerSession(
      await sha256(token),
      c.req.param('id'),
      c.var.admin.name,
    );
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
      } satisfies PublicConfig),
    )
    .get('/session', async (c) => c.json(await findSession(c)))
    .post('/join', body(joinInput), async (c) => {
      const { platform, config } = c.var;
      if (config.mode === 'shared') throw notFound('共享模式无需口令');
      if (!(await platform.rateLimit('join', clientIp(c)))) throw new AppError(429, '尝试过于频繁，请稍后再试');
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

/** 前端通过 hono/client 使用的端到端类型 */
export type ApiType = ReturnType<typeof buildApi>;

/** 由服务端处理的路径；其余都是前端静态资源（Cloudflare 上需与 wrangler.jsonc 的 run_worker_first 保持一致） */
export const SERVER_PATHS = ['/api/*', '/mcp', '/mcp/*', '/oauth/token', '/oauth/register', '/oauth/revoke', '/.well-known/*'];

/**
 * 创建与平台无关的应用。inject 中间件负责为每个请求注入 platform 与 config：
 * Cloudflare 上来自 env 绑定，Node 上则是进程内单例。
 */
export function createApp(inject: MiddlewareHandler<AppEnv>) {
  // 不区分结尾斜杠：用户粘贴 https://…/mcp/ 也能连上
  const app = new Hono<AppEnv>({ strict: false });
  app.use('/api/*', async (c, next) => {
    // 拒绝跨站的写请求（JSON 请求本身也会触发 CORS 预检，这里再加一道保险）
    // 只比较主机名：反向代理（如 Traefik 终止 TLS）后协议可能不同
    const origin = c.req.header('origin');
    const host = c.req.header('x-forwarded-host') ?? new URL(c.req.url).host;
    if (c.req.method !== 'GET' && origin && URL.parse(origin)?.host !== host) {
      return c.json({ error: '跨站请求被拒绝' }, 403);
    }
    await next();
  });
  for (const path of SERVER_PATHS) app.use(path, inject);
  app.route('/api', buildApi());
  app.all('/api/*', (c) => c.json({ error: '接口不存在' }, 404));
  // MCP 与 OAuth 端点面向 AI 应用，不走 Cookie，也不受上面的同源写保护
  app.route('/mcp', mcpRoutes);
  app.route('/oauth', oauthRoutes);
  app.route('/.well-known', wellKnownRoutes);
  // 未实现的发现文档（如 openid-configuration）明确返回 404，不能落到前端页面
  app.all('/.well-known/*', (c) => c.json({ error: 'not_found' }, 404));
  app.all('/mcp/*', (c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    if (err instanceof OAuthError) {
      if (err.status === 401) c.header('WWW-Authenticate', 'Basic realm="aapay"');
      return c.json({ error: err.code, error_description: err.message }, err.status, { 'Cache-Control': 'no-store' });
    }
    if (err instanceof AppError) return c.json({ error: err.message }, err.status);
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: '服务器开小差了，请稍后再试' }, 500);
  });
  return app;
}

