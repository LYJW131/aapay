import { DurableObject } from 'cloudflare:workers';
import type { Context } from 'hono';
import type { LiveMessage, RegistryEvent } from '../../shared/types.ts';
import { createApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { createSigner } from '../core/audit.ts';
import { LedgerService } from '../core/ledger.ts';
import { RegistryService } from '../core/registry.ts';
import { dispatch, remote } from '../core/remote.ts';
import type { SqlDriver, SqlValue } from '../core/sql.ts';
import type { LedgerHost, Platform } from '../platform.ts';

export interface Env {
  LEDGER: DurableObjectNamespace<LedgerRoom>;
  REGISTRY: DurableObjectNamespace<RegistryRoom>;
  JOIN_LIMITER?: RateLimit;
  LOGIN_LIMITER?: RateLimit;
  ASSISTANT_LIMITER?: RateLimit;
}

const TAG_HEADER = 'x-aapay-tag';

function durableSql(storage: DurableObjectStorage): SqlDriver {
  const { sql } = storage;
  return {
    all: <T>(query: string, ...params: SqlValue[]) => sql.exec(query, ...params).toArray() as T[],
    run: (query, ...params) => void sql.exec(query, ...params).toArray(),
    exec: (query) => void sql.exec(query).toArray(),
    transaction: (fn) => storage.transactionSync(fn),
  };
}

abstract class LiveRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(request: Request) {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [request.headers.get(TAG_HEADER) ?? 'anonymous']);
    return new Response(null, { status: 101, webSocket: client });
  }

  protected broadcast(message: unknown, tag?: string) {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets(tag)) {
      try {
        ws.send(data);
      } catch {
      }
    }
  }

  override webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code >= 3000 && code <= 4999 ? code : 1000);
    } catch {
    }
  }
}

export class LedgerRoom extends LiveRoom {
  private readonly service: LedgerService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const { auditKey } = loadConfig(env);
    this.service = new LedgerService(
      durableSql(ctx.storage),
      (message: LiveMessage) => this.broadcast(message),
      auditKey && createSigner(auditKey),
    );
  }

  invoke(method: string, args: unknown[]) {
    return dispatch(this.service, method, args);
  }

  disconnect(tag: string) {
    const message: LiveMessage = { event: { type: 'ledger.closed', reason: 'revoked' }, at: Date.now() };
    this.broadcast(message, tag);
    for (const ws of this.ctx.getWebSockets(tag)) ws.close(4001, 'revoked');
  }

  async destroy() {
    this.service.notify({ type: 'ledger.closed', reason: 'deleted' });
    for (const ws of this.ctx.getWebSockets()) ws.close(4004, 'deleted');
    await this.ctx.storage.deleteAll();
  }
}

export class RegistryRoom extends LiveRoom {
  private readonly service: RegistryService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.service = new RegistryService(durableSql(ctx.storage), (event: RegistryEvent) => this.broadcast(event));
  }

  invoke(method: string, args: unknown[]) {
    return dispatch(this.service, method, args);
  }
}

function forwardUpgrade(stub: { fetch(request: Request): Promise<Response> }, c: Context, tag: string) {
  const headers = new Headers(c.req.raw.headers);
  headers.set(TAG_HEADER, tag);
  return stub.fetch(new Request(c.req.raw.url, { headers }));
}

function cloudflarePlatform(env: Env): Platform {
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry-apac'), { locationHint: 'apac' });
  return {
    registry: remote((method, args) => registry.invoke(method, args)),
    ledger(id): LedgerHost {
      const stub = env.LEDGER.get(env.LEDGER.idFromName(id), { locationHint: 'apac' });
      return {
        api: remote((method, args) => stub.invoke(method, args)),
        connect: (c, tag) => forwardUpgrade(stub, c, tag),
        disconnect: async (tag) => void (await stub.disconnect(tag)),
        destroy: async () => void (await stub.destroy()),
      };
    },
    connectConsole: (c) => forwardUpgrade(registry, c, 'console'),
    async rateLimit(bucket, key) {
      const limiter = { join: env.JOIN_LIMITER, login: env.LOGIN_LIMITER, assistant: env.ASSISTANT_LIMITER }[bucket];
      return limiter ? (await limiter.limit({ key })).success : true;
    },
  };
}

const app = createApp(async (c, next) => {
  const env = c.env as Env;
  try {
    c.set('config', loadConfig(env));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
  c.set('platform', cloudflarePlatform(env));
  await next();
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
