import type { Context } from 'hono';
import type { LedgerService } from './core/ledger.ts';
import type { RegistryService } from './core/registry.ts';
import type { Remote } from './core/remote.ts';

export interface LedgerHost {
  api: Remote<LedgerService>;
  // tag 用于撤销口令时按口令断开连接
  connect(c: Context, tag: string): Response | Promise<Response>;
  disconnect(tag: string): Promise<void>;
  destroy(): Promise<void>;
}

export type RateLimitBucket = 'join' | 'login' | 'recognize';

export type AiRunner = (model: string, input: Record<string, unknown>) => Promise<unknown>;

export interface Platform {
  registry: Remote<RegistryService>;
  ledger(id: string): LedgerHost;
  connectConsole(c: Context): Response | Promise<Response>;
  rateLimit(bucket: RateLimitBucket, key: string): Promise<boolean>;
  ai: AiRunner | null;
}
