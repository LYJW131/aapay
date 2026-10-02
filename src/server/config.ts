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
 * MCP                 enabled（默认）| disabled：是否开放 /mcp 端点（OAuth 2.1）供 Claude、ChatGPT 等连接
 * PUBLIC_URL          可选，对外访问地址，如 https://aapay.example.com；用作 OAuth issuer 与 MCP 资源标识。
 *                     不填则按请求推断（会信任 X-Forwarded-Proto / X-Forwarded-Host），反向代理后建议填写
 * TIMEZONE            可选，默认 Asia/Shanghai；AI 记账未指定日期时按此时区取「今天」
 */
export interface Config {
  mode: Mode;
  adminAuth: AdminAuthMode;
  accessTeamDomain: string;
  accessAud: string;
  adminPassword: string;
  adminEmailHeader: string;
  adminEmails: string[];
  mcp: boolean;
  publicUrl: string | null;
  timezone: string;
}

const MODES = ['isolated', 'shared'] as const;
const ADMIN_MODES = ['access', 'password', 'proxy', 'none', 'disabled'] as const;
const SWITCH = ['enabled', 'disabled'] as const;

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
    mcp: pick('MCP', SWITCH, 'enabled') === 'enabled',
    publicUrl: str('PUBLIC_URL').replace(/\/+$/, '') || null,
    timezone: str('TIMEZONE') || 'Asia/Shanghai',
  };

  if (config.mode === 'shared') config.adminAuth = 'disabled';
  if (config.adminAuth === 'access' && (!config.accessTeamDomain || !config.accessAud)) {
    throw new Error('ADMIN_AUTH=access 需要同时配置 ACCESS_TEAM_DOMAIN 与 ACCESS_AUD');
  }
  if (config.adminAuth === 'password' && config.adminPassword.length < 8) {
    throw new Error('ADMIN_AUTH=password 需要配置至少 8 位的 ADMIN_PASSWORD');
  }

  if (config.publicUrl && !/^https?:$/.test(URL.parse(config.publicUrl)?.protocol ?? '')) {
    throw new Error(`配置 PUBLIC_URL=${config.publicUrl} 无效，应形如 https://aapay.example.com`);
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: config.timezone });
  } catch {
    throw new Error(`配置 TIMEZONE=${config.timezone} 无效，应为 IANA 时区名，如 Asia/Shanghai`);
  }

  cache.set(env, config);
  return config;
}
