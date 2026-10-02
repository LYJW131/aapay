import type { AdminAuthMode, Mode } from '../shared/types.ts';

/**
 * 运行配置，Cloudflare（wrangler vars / secrets）与 Docker（环境变量）共用同一套变量名：
 *
 * MODE                isolated（默认，多账本 + 口令加入）| shared（单一公共账本，无需口令）
 * ADMIN_AUTH          access | password | proxy | none | disabled（默认）
 * ACCESS_TEAM_DOMAIN  ADMIN_AUTH=access 时必填，例如 myteam.cloudflareaccess.com
 * ACCESS_AUD          ADMIN_AUTH=access 时必填，Access 应用的 Application Audience (AUD) Tag
 * ADMIN_PASSWORD      ADMIN_AUTH=password 时必填，至少 8 位
 * ADMIN_EMAIL_HEADER  ADMIN_AUTH=proxy 时读取的身份头，默认 X-Forwarded-Email
 * ADMIN_EMAILS        可选，逗号分隔的管理员邮箱白名单（access / proxy 模式下生效）
 */
export interface Config {
  mode: Mode;
  adminAuth: AdminAuthMode;
  accessTeamDomain: string;
  accessAud: string;
  adminPassword: string;
  adminEmailHeader: string;
  adminEmails: string[];
}

const MODES = ['isolated', 'shared'] as const;
const ADMIN_MODES = ['access', 'password', 'proxy', 'none', 'disabled'] as const;

const cache = new WeakMap<object, Config>();

export function loadConfig(env: object): Config {
  const cached = cache.get(env);
  if (cached) return cached;

  const vars = env as Record<string, unknown>;
  const str = (key: string) => (typeof vars[key] === 'string' ? (vars[key] as string).trim() : '');
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = (str(key) || fallback).toLowerCase() as T;
    if (!allowed.includes(value)) throw new Error(`配置 ${key}=${value} 无效，可选值：${allowed.join(' | ')}`);
    return value;
  };

  const config: Config = {
    mode: pick('MODE', MODES, 'isolated'),
    adminAuth: pick('ADMIN_AUTH', ADMIN_MODES, 'disabled'),
    accessTeamDomain: str('ACCESS_TEAM_DOMAIN').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    accessAud: str('ACCESS_AUD'),
    adminPassword: str('ADMIN_PASSWORD'),
    adminEmailHeader: str('ADMIN_EMAIL_HEADER') || 'X-Forwarded-Email',
    adminEmails: str('ADMIN_EMAILS')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };

  if (config.mode === 'shared') config.adminAuth = 'disabled';
  if (config.adminAuth === 'access' && (!config.accessTeamDomain || !config.accessAud)) {
    throw new Error('ADMIN_AUTH=access 需要同时配置 ACCESS_TEAM_DOMAIN 与 ACCESS_AUD');
  }
  if (config.adminAuth === 'password' && config.adminPassword.length < 8) {
    throw new Error('ADMIN_AUTH=password 需要配置至少 8 位的 ADMIN_PASSWORD');
  }

  cache.set(env, config);
  return config;
}
