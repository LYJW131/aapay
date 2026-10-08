import { AI_PROVIDERS, type AiProvider } from '../shared/assistant.ts';
import { siteBaseUrl } from './ai/base-url.ts';
import type { AdminAuthMode, Mode } from '../shared/types.ts';

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
  trustProxy: boolean;
  timezone: string;
  auditKey: Uint8Array | null;
  assistant: AssistantConfig | null;
}

export interface AssistantConfig {
  provider: AiProvider;
  keys: Record<AiProvider, string | null>;
  models: Record<AiProvider, string>;
  openaiBaseUrl: string | null;
  idleTimeout: number;
}

const MODES = ['isolated', 'shared'] as const;
const ADMIN_MODES = ['access', 'password', 'proxy', 'none', 'disabled'] as const;
const SWITCH = ['enabled', 'disabled'] as const;

const cache = new WeakMap<object, Config>();

function decodeKey(value: string) {
  if (!value) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  } catch {
    bytes = new Uint8Array();
  }
  if (bytes.length !== 32) throw new Error('配置 AUDIT_SIGNING_KEY 无效，应为 32 字节的 base64url 字符串');
  return bytes;
}

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
    trustProxy: pick('TRUST_PROXY', SWITCH, 'disabled') === 'enabled',
    timezone: str('TIMEZONE') || 'Asia/Shanghai',
    auditKey: decodeKey(str('AUDIT_SIGNING_KEY')),
    assistant:
      pick('ASSISTANT', SWITCH, 'enabled') === 'enabled'
        ? {
            provider: pick('ASSISTANT_PROVIDER', AI_PROVIDERS, 'gemini'),
            keys: {
              gemini: str('GEMINI_API_KEY') || null,
              deepseek: str('DEEPSEEK_API_KEY') || null,
              claude: str('CLAUDE_API_KEY') || null,
              openai: str('OPENAI_API_KEY') || null,
            },
            models: {
              gemini: str('GEMINI_MODEL') || 'gemini-flash-lite-latest',
              deepseek: str('DEEPSEEK_MODEL') || 'deepseek-flash',
              claude: str('CLAUDE_MODEL') || 'claude-haiku-5-5',
              openai: str('OPENAI_MODEL'),
            },
            openaiBaseUrl: str('OPENAI_BASE_URL') ? siteBaseUrl(str('OPENAI_BASE_URL')) : null,
            idleTimeout: 45_000,
          }
        : null,
  };

  if (config.mode === 'shared') config.adminAuth = 'disabled';
  if (str('OPENAI_BASE_URL') && config.assistant && !config.assistant.openaiBaseUrl) {
    throw new Error(`配置 OPENAI_BASE_URL=${str('OPENAI_BASE_URL')} 无效，应形如 https://api.example.com/v1`);
  }
  if (config.assistant?.provider === 'openai' && (!config.assistant.openaiBaseUrl || !config.assistant.models.openai)) {
    throw new Error('ASSISTANT_PROVIDER=openai 需要同时配置 OPENAI_BASE_URL 与 OPENAI_MODEL');
  }
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

export function todayIn(timezone: string) {
  // en-CA 的日期格式恰好是 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}
