import type { Context } from 'hono';
import type { LedgerService } from './core/ledger.ts';
import type { RegistryService } from './core/registry.ts';
import type { Remote } from './core/remote.ts';

export interface LedgerHost {
  api: Remote<LedgerService>;
  /** 把当前请求升级为该账本的实时 WebSocket 连接；tag 用于之后按口令断开 */
  connect(c: Context, tag: string): Response | Promise<Response>;
  /** 断开带有某个 tag 的所有连接（口令被撤销时） */
  disconnect(tag: string): Promise<void>;
  /** 通知在线成员并永久删除账本数据 */
  destroy(): Promise<void>;
}

export type RateLimitBucket = 'join' | 'login';

/** 平台适配层：Cloudflare（Durable Objects）与 Node（node:sqlite + ws）各实现一份。 */
export interface Platform {
  registry: Remote<RegistryService>;
  ledger(id: string): LedgerHost;
  /** 管理控制台的实时连接（账本、口令变化时推送） */
  connectConsole(c: Context): Response | Promise<Response>;
  /** 返回 false 表示超出频率限制 */
  rateLimit(bucket: RateLimitBucket, key: string): Promise<boolean>;
}
