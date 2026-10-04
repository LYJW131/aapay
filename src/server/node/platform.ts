import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from 'hono';
import type { UpgradeWebSocket, WSContext } from 'hono/ws';
import type { LiveMessage } from '../../shared/types.ts';
import { createSigner, type AuditSigner } from '../core/audit.ts';
import { LedgerService } from '../core/ledger.ts';
import { RegistryService } from '../core/registry.ts';
import { dispatch, remote } from '../core/remote.ts';
import type { LedgerHost, Platform, RateLimitBucket } from '../platform.ts';
import { openSqlite } from './sqlite.ts';

class Room {
  private readonly sockets = new Map<WSContext, string>();

  constructor(private readonly upgrade: UpgradeWebSocket) {}

  connect(c: Context, tag: string) {
    return this.upgrade(c, {
      onOpen: (_, ws) => void this.sockets.set(ws, tag),
      onMessage: (event, ws) => {
        if (event.data === 'ping') ws.send('pong');
      },
      onClose: (_, ws) => void this.sockets.delete(ws),
    });
  }

  broadcast(message: unknown, tag?: string) {
    const data = JSON.stringify(message);
    for (const [ws, t] of this.sockets) if (!tag || t === tag) ws.send(data);
  }

  close(code: number, reason: string, tag?: string) {
    for (const [ws, t] of this.sockets) {
      if (tag && t !== tag) continue;
      ws.close(code, reason);
      this.sockets.delete(ws);
    }
  }
}

class NodeLedger implements LedgerHost {
  private readonly db;
  private readonly room;
  private readonly service;
  readonly api;

  constructor(
    private readonly path: string,
    upgrade: UpgradeWebSocket,
    signer: AuditSigner | null,
    private readonly onDestroy: () => void,
  ) {
    this.db = openSqlite(path);
    this.room = new Room(upgrade);
    this.service = new LedgerService(this.db, (message) => this.room.broadcast(message), signer);
    this.api = remote<LedgerService>((method, args) => dispatch(this.service, method, args));
  }

  connect(c: Context, tag: string) {
    return this.room.connect(c, tag);
  }

  async disconnect(tag: string) {
    const message: LiveMessage = { event: { type: 'ledger.closed', reason: 'revoked' }, at: Date.now() };
    this.room.broadcast(message, tag);
    this.room.close(4001, 'revoked', tag);
  }

  async destroy() {
    this.service.notify({ type: 'ledger.closed', reason: 'deleted' });
    this.room.close(4004, 'deleted');
    this.db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(this.path + suffix, { force: true });
    this.onDestroy();
  }
}

class RateLimiter {
  private readonly hits = new Map<string, { count: number; reset: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  take(key: string) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.reset <= now) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      return true;
    }
    return ++entry.count <= this.limit;
  }
}

export function createNodePlatform(
  dataDir: string,
  upgrade: UpgradeWebSocket,
  auditKey: Uint8Array | null = null,
): Platform {
  const signer = auditKey && createSigner(auditKey);
  const ledgerDir = join(dataDir, 'ledgers');
  mkdirSync(ledgerDir, { recursive: true });

  const consoleRoom = new Room(upgrade);
  const registryService = new RegistryService(openSqlite(join(dataDir, 'registry.db')), (event) =>
    consoleRoom.broadcast(event),
  );
  const ledgers = new Map<string, NodeLedger>();
  const limiters: Record<RateLimitBucket, RateLimiter> = {
    join: new RateLimiter(10, 60_000),
    login: new RateLimiter(5, 60_000),
    recognize: new RateLimiter(10, 60_000),
  };

  return {
    registry: remote<RegistryService>((method, args) => dispatch(registryService, method, args)),
    ledger(id) {
      if (!/^[\w-]{1,64}$/.test(id)) throw new Error(`非法账本 ID：${id}`);
      let ledger = ledgers.get(id);
      if (!ledger) {
        ledger = new NodeLedger(join(ledgerDir, `${id}.db`), upgrade, signer, () => ledgers.delete(id));
        ledgers.set(id, ledger);
      }
      return ledger;
    },
    connectConsole: (c) => consoleRoom.connect(c, 'console'),
    rateLimit: async (bucket, key) => limiters[bucket].take(key),
  };
}
