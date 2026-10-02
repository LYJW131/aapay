import { zValidator } from '@hono/zod-validator';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import {
  expenseInput,
  joinInput,
  ledgerInput,
  loginInput,
  memberInput,
  passphraseInput,
  settlementInput,
} from '../shared/schema.ts';
import type { AdminIdentity, LedgerInfo, LedgerOverview, PublicConfig, SessionInfo, Snapshot } from '../shared/types.ts';
import { authenticateAdmin, passwordMatches } from './auth/admin.ts';
import { clearSessionCookie, CONSOLE_COOKIE, SESSION_COOKIE, setSessionCookie } from './auth/cookies.ts';
import type { Config } from './config.ts';
import { AppError, notFound, unauthorized } from './core/errors.ts';
import { newToken, sha256 } from './core/ids.ts';
import type { Platform } from './platform.ts';

export type AppEnv = {
  Variables: {
    platform: Platform;
    config: Config;
    session: SessionInfo;
    admin: AdminIdentity;
  };
};

export const SHARED_LEDGER = { id: 'shared', name: '共享账本' } as const;

/** 统一的参数校验：失败时返回第一条中文错误信息 */
const body = <T extends z.ZodType>(schema: T) =>
  zValidator('json', schema, (result, c) => {
    if (!result.success) return c.json({ error: result.error.issues[0]?.message ?? '参数错误' }, 400);
  });

const clientIp = (c: Context) =>
  c.req.header('cf-connecting-ip') ??
  c.req.header('x-real-ip') ??
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
  'local';

const originOf = (c: Context) => c.req.header('x-client-id')?.slice(0, 64);

function requireUpgrade(c: Context) {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    throw new HTTPException(426, { message: 'Expected WebSocket upgrade' });
  }
}

let sharedLedger: Promise<LedgerInfo> | undefined;

/** 通过 Cookie 中的会话令牌确定所属账本；共享模式下所有人进入同一个账本 */
async function findSession(c: Context<AppEnv>): Promise<SessionInfo | null> {
  const { config, platform } = c.var;
  if (config.mode === 'shared') {
    sharedLedger ??= platform.registry.ensureLedger(SHARED_LEDGER.id, SHARED_LEDGER.name).catch((err: unknown) => {
      sharedLedger = undefined;
      throw err;
    });
    return { ledger: await sharedLedger, role: 'shared', passphrase: null, expiresAt: null };
  }
  const token = getCookie(c, SESSION_COOKIE);
  return token ? platform.registry.resolveLedgerSession(await sha256(token)) : null;
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
  );

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
  .get('/live', (c) => {
    requireUpgrade(c);
    return c.var.platform.connectConsole(c);
  })
  .get('/ledgers', async (c) => {
    const { platform } = c.var;
    const ledgers = await platform.registry.listLedgers();
    const stats = await Promise.all(ledgers.map((l) => platform.ledger(l.id).api.stats().catch(() => null)));
    return c.json(ledgers.map((l, i) => ({ ...l, stats: stats[i] ?? null }) satisfies LedgerOverview));
  })
  .post('/ledgers', body(ledgerInput), async (c) =>
    c.json(await c.var.platform.registry.createLedger(c.req.valid('json').name)),
  )
  .patch('/ledgers/:id', body(ledgerInput), async (c) => {
    const { platform } = c.var;
    const ledger = await platform.registry.renameLedger(c.req.param('id'), c.req.valid('json').name);
    await platform.ledger(ledger.id).api.notify({ type: 'ledger.renamed', name: ledger.name });
    return c.json(ledger);
  })
  .delete('/ledgers/:id', async (c) => {
    const { platform } = c.var;
    const ledger = await platform.registry.deleteLedger(c.req.param('id'));
    await platform.ledger(ledger.id).destroy();
    return c.json(ledger);
  })
  .get('/ledgers/:id/passphrases', async (c) =>
    c.json(await c.var.platform.registry.listPassphrases(c.req.param('id'))),
  )
  .post('/ledgers/:id/passphrases', body(passphraseInput), async (c) =>
    c.json(await c.var.platform.registry.createPassphrase(c.req.param('id'), c.req.valid('json'))),
  )
  .delete('/passphrases/:id', async (c) => {
    const { platform } = c.var;
    const passphrase = await platform.registry.revokePassphrase(c.req.param('id'));
    await platform.ledger(passphrase.ledgerId).disconnect(`p:${passphrase.code.toLowerCase()}`);
    return c.json(passphrase);
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
      c.json({ mode: c.var.config.mode, adminAuth: c.var.config.adminAuth } satisfies PublicConfig),
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
    .route('/admin', adminRoutes);
}

/** 前端通过 hono/client 使用的端到端类型 */
export type ApiType = ReturnType<typeof buildApi>;

/**
 * 创建与平台无关的应用。inject 中间件负责为每个请求注入 platform 与 config：
 * Cloudflare 上来自 env 绑定，Node 上则是进程内单例。
 */
export function createApp(inject: MiddlewareHandler<AppEnv>) {
  const app = new Hono<AppEnv>();
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
  app.use('/api/*', inject);
  app.route('/api', buildApi());
  app.all('/api/*', (c) => c.json({ error: '接口不存在' }, 404));
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: err.message }, err.status);
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: '服务器开小差了，请稍后再试' }, 500);
  });
  return app;
}

