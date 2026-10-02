import type { ClientResponse } from 'hono/client';
import { applyEvent } from '../../../shared/ledger.ts';
import type { LiveMessage, Snapshot } from '../../../shared/types.ts';
import { api, ApiError, call, CLIENT_ID, liveUrl } from '../../lib/api.ts';

export type LiveStatus = 'connecting' | 'online' | 'offline';
export type CloseReason = 'deleted' | 'revoked' | 'unauthorized';

export interface LedgerState {
  snapshot: Snapshot | null;
  live: LiveStatus;
  error: string | null;
}

interface Hooks {
  onClosed(reason: CloseReason): void;
  onRemote(message: LiveMessage, before: Snapshot): void;
}

export class LedgerStore {
  private state: LedgerState = { snapshot: null, live: 'connecting', error: null };
  private readonly listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private retries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private connectedBefore = false;
  private stopped = true;

  constructor(
    private readonly hooks: Hooks,
    initial: Snapshot | null = null,
  ) {
    this.state = { ...this.state, snapshot: initial };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getState = () => this.state;

  private set(patch: Partial<LedgerState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refresh();
    this.connect();
    document.addEventListener('visibilitychange', this.wake);
    window.addEventListener('online', this.wake);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    this.ws?.close(1000);
    this.ws = null;
    document.removeEventListener('visibilitychange', this.wake);
    window.removeEventListener('online', this.wake);
  }

  async refresh() {
    try {
      const snapshot = await call(api.ledger.$get());
      this.set({ snapshot, error: null });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return this.close('unauthorized');
      this.set({ error: (err as Error).message });
    }
  }

  // 立即应用服务端返回的事件，WebSocket 回声会因版本号相同而被忽略
  async mutate(request: Promise<ClientResponse<unknown>>) {
    try {
      const message = (await call(request)) as LiveMessage;
      this.receive(message);
      return message;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) this.close('unauthorized');
      throw err;
    }
  }

  private receive(message: LiveMessage) {
    const snapshot = this.state.snapshot;
    const { event } = message;
    if (event.type === 'ledger.closed') return this.close(event.reason);
    if (!snapshot) return;
    if (event.type === 'ledger.renamed') {
      return this.set({ snapshot: { ...snapshot, ledger: { ...snapshot.ledger, name: event.name } } });
    }
    if (message.v === undefined || message.v <= snapshot.version) return;
    if (message.v > snapshot.version + 1) return void this.refresh();
    this.set({ snapshot: { ...snapshot, ...applyEvent(snapshot, event, message.v) } });
    if (message.origin !== CLIENT_ID) this.hooks.onRemote(message, snapshot);
  }

  private close(reason: CloseReason) {
    if (this.stopped) return;
    this.stop();
    this.hooks.onClosed(reason);
  }

  private connect() {
    clearTimeout(this.reconnectTimer);
    if (this.stopped || this.ws) return;
    this.set({ live: 'connecting' });
    const ws = new WebSocket(liveUrl('/ledger/live'));
    this.ws = ws;

    ws.onopen = () => {
      this.retries = 0;
      this.set({ live: 'online' });
      this.heartbeat = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
      // 断线期间可能错过事件，重连后补一次快照
      if (this.connectedBefore) void this.refresh();
      this.connectedBefore = true;
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      try {
        this.receive(JSON.parse(e.data as string) as LiveMessage);
      } catch {
      }
    };
    ws.onclose = (e) => {
      clearInterval(this.heartbeat);
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      if (e.code === 4001) return this.close('revoked');
      if (e.code === 4004) return this.close('deleted');
      this.set({ live: 'offline' });
      const delay = Math.min(30_000, 1000 * 2 ** this.retries++);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private wake = () => {
    if (document.visibilityState === 'visible' && !this.ws && !this.stopped) {
      this.retries = 0;
      this.connect();
    }
  };
}
