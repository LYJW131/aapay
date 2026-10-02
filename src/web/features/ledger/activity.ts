import { AUDIT_GENESIS, verifyAudit, type AuditCheckpoint, type AuditRecord } from '../../../shared/audit.ts';
import { api, call, errorMessage } from '../../lib/api.ts';
import { load, save } from '../../lib/storage.ts';

export type AuditStatus =
  | { state: 'verifying' }
  | { state: 'ok'; count: number; signed: boolean }
  | { state: 'failed'; seq: number; reason: string }
  | { state: 'error'; message: string };

export interface ActivityState {
  entries: AuditRecord[] | null;
  status: AuditStatus;
  loadingMore: boolean;
  unread: boolean;
}

const VERIFY_PAGE = 500;
const PAGE = 30;

class Broken extends Error {
  constructor(
    readonly seq: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

export class ActivityLog {
  private state: ActivityState = { entries: null, status: { state: 'verifying' }, loadingMore: false, unread: false };
  private readonly listeners = new Set<() => void>();
  private checkpoint: AuditCheckpoint | null;
  private seen: number | null;
  private publicKey: string | null = null;
  private syncing: Promise<void> | null = null;
  private dirty = false;

  constructor(private readonly prefix: string) {
    this.checkpoint = load<AuditCheckpoint | null>(`${prefix}audit`, null);
    this.seen = load<number | null>(`${prefix}audit-seen`, null);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getState = () => this.state;

  private set(patch: Partial<ActivityState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  sync(): Promise<void> {
    if (this.syncing) {
      this.dirty = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.dirty = false;
        await this.run();
      } while (this.dirty && this.state.status.state === 'ok');
    })().finally(() => (this.syncing = null));
    return this.syncing;
  }

  receive(record: AuditRecord, own: boolean) {
    if (this.state.status.state === 'failed') return;
    if (this.syncing) return void (this.dirty = true);
    if (this.state.status.state !== 'ok') return;
    const head = this.checkpoint?.seq ?? 0;
    if (record.seq <= head) return;
    if (record.seq > head + 1) return void this.sync();
    const verdict = verifyAudit([record], this.publicKey, this.checkpoint);
    if (!verdict.ok) return this.fail(new Broken(verdict.seq, verdict.reason));
    if (own && this.seen === head) this.markSeen(record.seq);
    this.advance(verdict.checkpoint, [record]);
  }

  async loadMore() {
    const oldest = this.state.entries?.at(-1);
    if (!oldest || oldest.seq <= 1 || this.state.loadingMore || this.state.status.state !== 'ok') return;
    this.set({ loadingMore: true });
    try {
      const older = await this.fetchBefore(oldest.seq, oldest.prev, 50);
      this.set({ entries: [...(this.state.entries ?? []), ...older], loadingMore: false });
    } catch (err) {
      this.set({ loadingMore: false });
      this.fail(err);
    }
  }

  markSeen(seq = this.checkpoint?.seq ?? 0) {
    if (this.seen === seq) return;
    this.seen = seq;
    save(`${this.prefix}audit-seen`, seq);
    this.set({ unread: false });
  }

  private async run() {
    try {
      let checkpoint = this.checkpoint;
      const fresh: AuditRecord[] = [];
      for (;;) {
        const page = await call(
          api.ledger.audit.$get({ query: { after: String(checkpoint?.seq ?? 0), limit: String(VERIFY_PAGE) } }),
        );
        this.publicKey = page.publicKey;
        const verdict = verifyAudit(page.records, page.publicKey, checkpoint);
        if (!verdict.ok) throw new Broken(verdict.seq, verdict.reason);
        checkpoint = verdict.checkpoint;
        fresh.push(...page.records);
        if (page.records.length < VERIFY_PAGE) {
          if (page.head?.seq !== checkpoint?.seq || page.head?.hash !== checkpoint?.hash) {
            throw new Broken(checkpoint?.seq ?? 0, '服务器上的记录比上次校验时少，或已被改写');
          }
          break;
        }
      }
      if (this.seen === null) this.markSeen(checkpoint?.seq ?? 0);
      if (this.state.entries === null && checkpoint && fresh.length < Math.min(PAGE, checkpoint.seq)) {
        const before = await this.fetchBefore(checkpoint.seq + 1, checkpoint.hash, PAGE);
        this.set({ entries: [] });
        this.advance(checkpoint, [...before].reverse());
      } else {
        this.set({ entries: this.state.entries ?? [] });
        this.advance(checkpoint, fresh.slice(this.state.entries!.length === 0 ? -PAGE : 0));
      }
    } catch (err) {
      this.fail(err);
    }
  }

  private advance(checkpoint: AuditCheckpoint | null, ascending: AuditRecord[]) {
    this.checkpoint = checkpoint;
    save(`${this.prefix}audit`, checkpoint);
    const count = checkpoint?.seq ?? 0;
    const entries = this.state.entries ?? [];
    const top = entries[0]?.seq ?? 0;
    this.set({
      entries: [...ascending.filter((r) => r.seq > top).reverse(), ...entries],
      status: { state: 'ok', count, signed: !!this.publicKey },
      unread: this.seen !== null && count > this.seen,
    });
  }

  // 只有能从已校验的最新记录沿 prev 哈希一路接上的旧记录才会显示
  private async fetchBefore(before: number, newestHash: string, limit: number) {
    const page = await call(api.ledger.audit.$get({ query: { before: String(before), limit: String(limit) } }));
    const ascending = [...page.records].reverse();
    const oldest = ascending[0];
    if (!oldest) return [];
    const verdict = verifyAudit(ascending, null, { seq: oldest.seq - 1, hash: oldest.seq === 1 ? AUDIT_GENESIS : oldest.prev, publicKey: null });
    if (!verdict.ok) throw new Broken(verdict.seq, verdict.reason);
    const newest = ascending.at(-1)!;
    if (newest.seq !== before - 1 || newest.hash !== newestHash) throw new Broken(newest.seq, '与已校验的记录对不上');
    return page.records;
  }

  private fail(err: unknown) {
    if (err instanceof Broken) return this.set({ status: { state: 'failed', seq: err.seq, reason: err.reason } });
    this.set({ status: { state: 'error', message: errorMessage(err) } });
  }
}
