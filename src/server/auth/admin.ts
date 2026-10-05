import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AdminIdentity } from '../../shared/types.ts';
import type { Config } from '../config.ts';
import { sha256 } from '../core/ids.ts';
import type { Platform } from '../platform.ts';
import { CONSOLE_COOKIE } from './cookies.ts';

const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(team: string) {
  let set = jwksByTeam.get(team);
  if (!set) jwksByTeam.set(team, (set = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`))));
  return set;
}

// 白名单只在 access / proxy 模式下生效
export function stillAdmin(config: Config, subject: string | null) {
  if (config.adminAuth === 'disabled' || !subject) return false;
  if (config.adminAuth !== 'access' && config.adminAuth !== 'proxy') return true;
  return config.adminEmails.length === 0 || config.adminEmails.includes(subject.toLowerCase());
}

// 即使边缘已有 Access 拦截，仍独立校验 Access JWT，防止绕过 Access 直连 Worker
export async function externalAdmin(c: Context, config: Config): Promise<string | null> {
  let identity: string | null = null;
  switch (config.adminAuth) {
    case 'none':
      identity = 'developer';
      break;
    case 'access': {
      const token = c.req.header('cf-access-jwt-assertion') ?? getCookie(c, 'CF_Authorization');
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, jwks(config.accessTeamDomain), {
          issuer: `https://${config.accessTeamDomain}`,
          audience: config.accessAud,
        });
        // 用户登录带 email；Service Token 调用带 common_name
        identity = String(payload.email ?? payload.common_name ?? '') || null;
      } catch {
        return null;
      }
      break;
    }
    case 'proxy':
      identity = c.req.header(config.adminEmailHeader)?.trim() || null;
      break;
  }
  return stillAdmin(config, identity) ? identity : null;
}

export async function authenticateAdmin(c: Context, config: Config, platform: Platform): Promise<{ identity: AdminIdentity; consoleHash: string } | null> {
  if (config.adminAuth === 'disabled') return null;
  const token = getCookie(c, CONSOLE_COOKIE);
  if (!token) return null;
  const consoleHash = await sha256(token);
  const session = await platform.registry.resolveConsoleSession(consoleHash);
  return session && stillAdmin(config, session.subject) ? { identity: { name: session.subject }, consoleHash } : null;
}

// 常量时间比较，避免通过响应时间猜测密码
export async function passwordMatches(input: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(input), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
