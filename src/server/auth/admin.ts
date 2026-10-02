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

const allowed = (config: Config, identity: string) =>
  config.adminEmails.length === 0 || config.adminEmails.includes(identity.toLowerCase());

/**
 * 校验管理员身份。即使边缘已有 Cloudflare Access 拦截，Worker 仍会独立校验
 * Access 签发的 JWT（签名、issuer、audience），防止绕过 Access 直接访问。
 */
export async function authenticateAdmin(c: Context, config: Config, platform: Platform): Promise<AdminIdentity | null> {
  switch (config.adminAuth) {
    case 'none':
      return { name: 'developer', method: 'none' };

    case 'access': {
      const token = c.req.header('cf-access-jwt-assertion') ?? getCookie(c, 'CF_Authorization');
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, jwks(config.accessTeamDomain), {
          issuer: `https://${config.accessTeamDomain}`,
          audience: config.accessAud,
        });
        // 用户登录带 email；Service Token 调用带 common_name
        const identity = String(payload.email ?? payload.common_name ?? '');
        return identity && allowed(config, identity) ? { name: identity, method: 'access' } : null;
      } catch {
        return null;
      }
    }

    case 'proxy': {
      const identity = c.req.header(config.adminEmailHeader)?.trim();
      return identity && allowed(config, identity) ? { name: identity, method: 'proxy' } : null;
    }

    case 'password': {
      const token = getCookie(c, CONSOLE_COOKIE);
      if (!token) return null;
      const session = await platform.registry.resolveConsoleSession(await sha256(token));
      return session ? { name: session.subject, method: 'password' } : null;
    }

    default:
      return null;
  }
}

/** 常量时间比较，避免通过响应时间猜测密码 */
export async function passwordMatches(input: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(input), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
