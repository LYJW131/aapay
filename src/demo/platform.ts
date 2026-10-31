import type { Context } from 'hono';
import type { Database, SqlJsStatic } from 'sql.js';
import type { LiveMessage } from '../shared/types.ts';
import { createSigner, type AuditSigner } from '../server/core/audit.ts';
import { LedgerService } from '../server/core/ledger.ts';
import { RegistryService } from '../server/core/registry.ts';
import { dispatch, remote } from '../server/core/remote.ts';
import type { LedgerHost, Platform } from '../server/platform.ts';
import { exportDb, sqlDriver } from './sqlite.ts';
import type { Saved } from './store.ts';

export interface ServerSocket {
  deliver(data: string): void;
  shut(code: number, reason: string): void;
  detach?: () => void;
}

export type DemoEnv = { socket?: ServerSocket };

const REGISTRY = 'registry';
const AUDIT_KEY = 'audit-key';
const ledgerKey = (id: string) => `ledger:${id}`;

class Room {
  private readonly sockets = new Map<ServerSocket, string>();

  connect(c: Context, tag: string) {
    const socket = (c.env as DemoEnv | undefined)?.socket;
    if (!socket) return c.json({ error: 'Expected WebSocket upgrade' }, 426);
    this.sockets.set(socket, tag);
    socket.detach = () => void this.sockets.delete(socket);
    return c.body(null, 200);
  }

  broadcast(message: unknown, tag?: string) {
    const data = JSON.stringify(message);
    for (const [socket, t] of this.sockets) if (!tag || t === tag) socket.deliver(data);
  }

  close(code: number, reason: string, tag?: string) {
    for (const [socket, t] of this.sockets) {
      if (tag && t !== tag) continue;
      this.sockets.delete(socket);
      socket.shut(code, reason);
    }
  }
}

class DemoLedger implements LedgerHost {
  private readonly room = new Room();
  private readonly service: LedgerService;
  readonly api;

  constructor(
    readonly db: Database,
    signer: AuditSigner,
    private readonly onDestroy: () => void,
  ) {
    this.service = new LedgerService(sqlDriver(db), (message) => this.room.broadcast(message), signer);
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
    this.onDestroy();
  }
}

export function createDemoPlatform(SQL: SqlJsStatic, saved: Saved) {
  const open = (key: string) => {
    const bytes = saved.get(key);
    return bytes ? new SQL.Database(bytes) : new SQL.Database();
  };
  const auditKey = saved.get(AUDIT_KEY) ?? crypto.getRandomValues(new Uint8Array(32));
  const signer = createSigner(auditKey);
  const registryDb = open(REGISTRY);
  const consoleRoom = new Room();
  const registryService = new RegistryService(sqlDriver(registryDb), (event) => consoleRoom.broadcast(event));
  const ledgers = new Map<string, DemoLedger>();
  const deleted = new Set<string>();

  const platform: Platform = {
    registry: remote<RegistryService>((method, args) => dispatch(registryService, method, args)),
    ledger(id) {
      if (!/^[\w-]{1,64}$/.test(id)) throw new Error(`非法账本 ID：${id}`);
      let ledger = ledgers.get(id);
      if (!ledger) {
        deleted.delete(id);
        ledger = new DemoLedger(open(ledgerKey(id)), signer, () => {
          ledgers.delete(id);
          deleted.add(id);
        });
        ledgers.set(id, ledger);
      }
      return ledger;
    },
    connectConsole: (c) => consoleRoom.connect(c, 'console'),
    rateLimit: async () => true,
    clientIp: () => 'browser',
  };

  const snapshot = (): Saved => {
    const next: Saved = new Map(saved);
    next.set(AUDIT_KEY, auditKey);
    next.set(REGISTRY, exportDb(registryDb));
    for (const [id, ledger] of ledgers) next.set(ledgerKey(id), exportDb(ledger.db));
    for (const id of deleted) next.delete(ledgerKey(id));
    return next;
  };

  return { platform, snapshot, fresh: !saved.has(REGISTRY) };
}
