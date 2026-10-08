import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AuditActor } from '../shared/audit.ts';
import type { LedgerInfo, SessionInfo } from '../shared/types.ts';
import type { AppEnv } from './app.ts';
import { stillAdmin } from './auth/admin.ts';
import { SESSION_COOKIE } from './auth/cookies.ts';
import { sha256 } from './core/ids.ts';

export const SHARED_LEDGER = { id: 'shared', name: '共享账本' } as const;

let sharedLedger: Promise<LedgerInfo> | undefined;

export async function findSession(c: Context<AppEnv>): Promise<SessionInfo | null> {
  const { config, platform } = c.var;
  if (config.mode === 'shared') {
    sharedLedger ??= platform.registry.ensureLedger(SHARED_LEDGER.id, SHARED_LEDGER.name).catch((err: unknown) => {
      sharedLedger = undefined;
      throw err;
    });
    return { ledger: await sharedLedger, role: 'shared', passphrase: null, subject: null, expiresAt: null };
  }
  const token = getCookie(c, SESSION_COOKIE);
  const session = token ? await platform.registry.resolveLedgerSession(await sha256(token)) : null;
  return session?.role === 'admin' && !stillAdmin(config, session.subject) ? null : session;
}

export const clientIp = (c: Context<AppEnv>) => c.var.platform.clientIp(c, c.var.config.trustProxy);

export function actorOf(session: SessionInfo): AuditActor {
  if (session.role === 'shared') return { kind: 'shared' };
  if (session.role === 'admin') return { kind: 'admin', name: session.subject ?? 'admin' };
  return { kind: 'member', passphrase: session.passphrase };
}
