import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { LedgerInfo, SessionInfo } from '../shared/types.ts';
import type { AppEnv } from './app.ts';
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
    return { ledger: await sharedLedger, role: 'shared', passphrase: null, expiresAt: null };
  }
  const token = getCookie(c, SESSION_COOKIE);
  return token ? platform.registry.resolveLedgerSession(await sha256(token)) : null;
}

export const clientIp = (c: Context) =>
  c.req.header('cf-connecting-ip') ??
  c.req.header('x-real-ip') ??
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
  'local';
