import { byMemberOrder } from '../../shared/ledger.ts';
import { splitEvenly } from '../../shared/money.ts';
import { LIMITS, type ExpenseInput, type MemberInput, type SettlementInput } from '../../shared/schema.ts';
import type {
  Expense,
  LedgerData,
  LedgerEvent,
  LedgerStats,
  LiveMessage,
  Member,
  Settlement,
} from '../../shared/types.ts';
import {
  AUDIT_GENESIS,
  auditHash,
  type AuditAction,
  type AuditActor,
  type AuditExpense,
  type AuditPage,
  type AuditPayload,
  type AuditRecord,
  type AuditSettlement,
} from '../../shared/audit.ts';
import type { AuditSigner } from './audit.ts';
import { badRequest, conflict, notFound } from './errors.ts';
import { newId } from './ids.ts';
import { first, migrate, type SqlDriver } from './sql.ts';

const MIGRATIONS = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  INSERT INTO meta (key, value) VALUES ('version', 0);

  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    avatar TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE expenses (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    payer_id TEXT NOT NULL REFERENCES members (id),
    date TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX expenses_date ON expenses (date);

  CREATE TABLE expense_shares (
    expense_id TEXT NOT NULL REFERENCES expenses (id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES members (id),
    amount INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (expense_id, member_id)
  );
  CREATE INDEX expense_shares_member ON expense_shares (member_id);

  CREATE TABLE settlements (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES members (id),
    to_id TEXT NOT NULL REFERENCES members (id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    date TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX settlements_date ON settlements (date);
  `,
  `
  CREATE TABLE audit_log (
    seq INTEGER PRIMARY KEY,
    payload TEXT NOT NULL,
    prev TEXT NOT NULL,
    hash TEXT NOT NULL,
    sig TEXT
  );
  -- 只能追加：哈希链之外再挡住应用自身的误改
  CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `,
];

export interface MutationContext {
  actor: AuditActor;
  origin?: string;
}

export const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐨', '🐯', '🦁', '🐸', '🐵', '🐧', '🦄', '🐙'];

type MemberRow = { id: string; name: string; avatar: string; created_at: number };
type ExpenseRow = {
  id: string;
  title: string;
  amount: number;
  payer_id: string;
  date: string;
  created_at: number;
  updated_at: number;
};
type ShareRow = { expense_id: string; member_id: string; amount: number };
type SettlementRow = {
  id: string;
  from_id: string;
  to_id: string;
  amount: number;
  date: string;
  note: string | null;
  created_at: number;
};

const toMember = (r: MemberRow): Member => ({ id: r.id, name: r.name, avatar: r.avatar, createdAt: r.created_at });
const toSettlement = (r: SettlementRow): Settlement => ({
  id: r.id,
  fromId: r.from_id,
  toId: r.to_id,
  amount: r.amount,
  date: r.date,
  note: r.note,
  createdAt: r.created_at,
});

export class LedgerService {
  constructor(
    private readonly db: SqlDriver,
    private readonly emit: (message: LiveMessage) => void,
    private readonly signer: AuditSigner | null = null,
  ) {
    migrate(db, MIGRATIONS);
  }

  snapshot(): LedgerData {
    return {
      version: this.version(),
      members: this.members(),
      expenses: this.expenses(),
      settlements: this.db
        .all<SettlementRow>('SELECT * FROM settlements ORDER BY date DESC, created_at DESC')
        .map(toSettlement),
    };
  }

  stats(): LedgerStats {
    const row = first(
      this.db.all<{ members: number; expenses: number; settlements: number; total: number; last: number | null }>(
        `SELECT
           (SELECT COUNT(*) FROM members) AS members,
           (SELECT COUNT(*) FROM expenses) AS expenses,
           (SELECT COUNT(*) FROM settlements) AS settlements,
           (SELECT COALESCE(SUM(amount), 0) FROM expenses) AS total,
           MAX((SELECT MAX(updated_at) FROM expenses), (SELECT MAX(created_at) FROM settlements)) AS last`,
      ),
    )!;
    return {
      members: row.members,
      expenses: row.expenses,
      settlements: row.settlements,
      total: row.total,
      lastActivityAt: row.last,
    };
  }

  createMember(input: MemberInput, ctx: MutationContext) {
    return this.commit(ctx, () => {
      if (this.count('members') >= LIMITS.members) throw badRequest('memberLimit');
      this.assertNameFree(input.name);
      const member: Member = {
        id: newId(),
        name: input.name,
        avatar: input.avatar || AVATARS[Math.floor(Math.random() * AVATARS.length)]!,
        // 保证严格递增，成员顺序（以及零头分配）始终稳定
        createdAt: Math.max(Date.now(), (first(this.db.all<{ t: number | null }>('SELECT MAX(created_at) AS t FROM members'))?.t ?? 0) + 1),
      };
      this.db.run(
        'INSERT INTO members (id, name, avatar, created_at) VALUES (?, ?, ?, ?)',
        member.id,
        member.name,
        member.avatar,
        member.createdAt,
      );
      return {
        event: { type: 'member.saved', member },
        audit: { type: 'member.create', name: member.name, avatar: member.avatar },
      };
    });
  }

  updateMember(id: string, input: MemberInput, ctx: MutationContext) {
    return this.commit(ctx, () => {
      const current = this.member(id);
      this.assertNameFree(input.name, id);
      const member: Member = { ...current, name: input.name, avatar: input.avatar || current.avatar };
      if (member.name === current.name && member.avatar === current.avatar) return { event: { type: 'member.saved', member }, audit: null };
      this.db.run('UPDATE members SET name = ?, avatar = ? WHERE id = ?', member.name, member.avatar, id);
      return {
        event: { type: 'member.saved', member },
        audit: {
          type: 'member.update',
          before: { name: current.name, avatar: current.avatar },
          after: { name: member.name, avatar: member.avatar },
        },
      };
    });
  }

  deleteMember(id: string, ctx: MutationContext) {
    return this.commit(ctx, () => {
      const member = this.member(id);
      const used = first(
        this.db.all(
          `SELECT 1 FROM expenses WHERE payer_id = ?
           UNION ALL SELECT 1 FROM expense_shares WHERE member_id = ?
           UNION ALL SELECT 1 FROM settlements WHERE from_id = ? OR to_id = ?
           LIMIT 1`,
          id,
          id,
          id,
          id,
        ),
      );
      if (used) throw conflict('memberInUse');
      this.db.run('DELETE FROM members WHERE id = ?', id);
      return { event: { type: 'member.deleted', id }, audit: { type: 'member.delete', name: member.name } };
    });
  }

  createExpense(input: ExpenseInput, ctx: MutationContext) {
    return this.commit(ctx, () => {
      const now = Date.now();
      const expense = this.buildExpense(newId(), input, now, now);
      this.db.run(
        'INSERT INTO expenses (id, title, amount, payer_id, date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        expense.id,
        expense.title,
        expense.amount,
        expense.payerId,
        expense.date,
        expense.createdAt,
        expense.updatedAt,
      );
      this.writeShares(expense);
      return { event: { type: 'expense.saved', expense }, audit: { type: 'expense.create', expense: this.auditExpense(expense) } };
    });
  }

  updateExpense(id: string, input: ExpenseInput, ctx: MutationContext) {
    return this.commit(ctx, () => {
      const current = this.expense(id);
      const expense = this.buildExpense(id, input, current.createdAt, Date.now());
      if (sameExpense(current, expense)) return { event: { type: 'expense.saved', expense: current }, audit: null };
      this.db.run(
        'UPDATE expenses SET title = ?, amount = ?, payer_id = ?, date = ?, updated_at = ? WHERE id = ?',
        expense.title,
        expense.amount,
        expense.payerId,
        expense.date,
        expense.updatedAt,
        id,
      );
      this.db.run('DELETE FROM expense_shares WHERE expense_id = ?', id);
      this.writeShares(expense);
      return {
        event: { type: 'expense.saved', expense },
        audit: { type: 'expense.update', before: this.auditExpense(current), after: this.auditExpense(expense) },
      };
    });
  }

  deleteExpense(id: string, ctx: MutationContext) {
    return this.commit(ctx, () => {
      const expense = this.expense(id);
      this.db.run('DELETE FROM expenses WHERE id = ?', id);
      return { event: { type: 'expense.deleted', id }, audit: { type: 'expense.delete', expense: this.auditExpense(expense) } };
    });
  }

  createSettlement(input: SettlementInput, ctx: MutationContext) {
    return this.commit(ctx, () => {
      this.member(input.fromId);
      this.member(input.toId);
      const settlement: Settlement = {
        id: newId(),
        fromId: input.fromId,
        toId: input.toId,
        amount: input.amount,
        date: input.date,
        note: input.note || null,
        createdAt: Date.now(),
      };
      this.db.run(
        'INSERT INTO settlements (id, from_id, to_id, amount, date, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        settlement.id,
        settlement.fromId,
        settlement.toId,
        settlement.amount,
        settlement.date,
        settlement.note,
        settlement.createdAt,
      );
      return {
        event: { type: 'settlement.saved', settlement },
        audit: { type: 'settlement.create', settlement: this.auditSettlement(settlement) },
      };
    });
  }

  deleteSettlement(id: string, ctx: MutationContext) {
    return this.commit(ctx, () => {
      const row = first(this.db.all<SettlementRow>('SELECT * FROM settlements WHERE id = ?', id));
      if (!row) throw notFound('settlementNotFound');
      this.db.run('DELETE FROM settlements WHERE id = ?', id);
      return {
        event: { type: 'settlement.deleted', id },
        audit: { type: 'settlement.delete', settlement: this.auditSettlement(toSettlement(row)) },
      };
    });
  }

  // 不改变版本号：客户端用版本号检测漏掉的账目事件
  notify(event: LedgerEvent) {
    this.emit({ event, at: Date.now() });
  }

  record(actor: AuditActor, action: AuditAction): AuditRecord {
    const audit = this.db.transaction(() => this.appendAudit(actor, action));
    this.emit({ event: { type: 'audit.appended' }, audit, at: Date.now() });
    return audit;
  }

  auditLog(query: { before?: number; after?: number; limit: number }): AuditPage {
    const limit = Math.min(Math.max(query.limit, 1), 500);
    const records =
      query.after !== undefined
        ? this.db.all<AuditRecord>('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?', query.after, limit)
        : this.db.all<AuditRecord>('SELECT * FROM audit_log WHERE seq < ? ORDER BY seq DESC LIMIT ?', query.before ?? Number.MAX_SAFE_INTEGER, limit);
    return { records, publicKey: this.signer?.publicKey ?? null, head: this.auditHead() };
  }

  private commit(ctx: MutationContext, mutate: () => { event: LedgerEvent; audit: AuditAction | null }): LiveMessage {
    const message = this.db.transaction((): LiveMessage => {
      const { event, audit } = mutate();
      if (!audit) return { origin: ctx.origin, event, at: Date.now() };
      const { value } = first(
        this.db.all<{ value: number }>("UPDATE meta SET value = value + 1 WHERE key = 'version' RETURNING value"),
      )!;
      return { v: value, origin: ctx.origin, event, at: Date.now(), audit: this.appendAudit(ctx.actor, audit) } satisfies LiveMessage;
    });
    if (message.v !== undefined) this.emit(message);
    return message;
  }

  private auditHead() {
    return first(this.db.all<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')) ?? null;
  }

  private appendAudit(actor: AuditActor, action: AuditAction): AuditRecord {
    const head = this.auditHead();
    const seq = (head?.seq ?? 0) + 1;
    const prev = head?.hash ?? AUDIT_GENESIS;
    const payload = JSON.stringify({ seq, at: Date.now(), actor, action } satisfies AuditPayload);
    const hash = auditHash(prev, payload);
    const record: AuditRecord = { seq, payload, prev, hash, sig: this.signer?.sign(hash) ?? null };
    this.db.run('INSERT INTO audit_log (seq, payload, prev, hash, sig) VALUES (?, ?, ?, ?, ?)', seq, payload, prev, hash, record.sig);
    return record;
  }

  private auditExpense(e: Expense): AuditExpense {
    const name = (id: string) => this.memberName(id);
    return {
      id: e.id,
      title: e.title,
      amount: e.amount,
      payer: name(e.payerId),
      participants: e.shares.map((s) => name(s.memberId)),
      date: e.date,
    };
  }

  private auditSettlement(s: Settlement): AuditSettlement {
    return { id: s.id, from: this.memberName(s.fromId), to: this.memberName(s.toId), amount: s.amount, date: s.date, note: s.note };
  }

  private memberName(id: string) {
    return first(this.db.all<{ name: string }>('SELECT name FROM members WHERE id = ?', id))?.name ?? '（已删除成员）';
  }

  private expense(id: string): Expense {
    const found = this.expenses().find((e) => e.id === id);
    if (!found) throw notFound('expenseNotFound');
    return found;
  }

  private version() {
    return first(this.db.all<{ value: number }>("SELECT value FROM meta WHERE key = 'version'"))?.value ?? 0;
  }

  private count(table: 'members' | 'expenses') {
    return first(this.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
  }

  private members(): Member[] {
    return this.db.all<MemberRow>('SELECT * FROM members ORDER BY created_at, id').map(toMember);
  }

  private member(id: string): Member {
    const row = first(this.db.all<MemberRow>('SELECT * FROM members WHERE id = ?', id));
    if (!row) throw notFound('memberNotFound');
    return toMember(row);
  }

  private assertNameFree(name: string, exceptId = '') {
    if (first(this.db.all('SELECT 1 FROM members WHERE name = ? AND id != ?', name, exceptId))) {
      throw conflict('memberExists', { name });
    }
  }

  private expenses(): Expense[] {
    const shares = new Map<string, { memberId: string; amount: number }[]>();
    for (const s of this.db.all<ShareRow>('SELECT * FROM expense_shares ORDER BY expense_id, position')) {
      let list = shares.get(s.expense_id);
      if (!list) shares.set(s.expense_id, (list = []));
      list.push({ memberId: s.member_id, amount: s.amount });
    }
    return this.db
      .all<ExpenseRow>('SELECT * FROM expenses ORDER BY date DESC, created_at DESC')
      .map((r) => ({
        id: r.id,
        title: r.title,
        amount: r.amount,
        payerId: r.payer_id,
        date: r.date,
        shares: shares.get(r.id) ?? [],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
  }

  private buildExpense(id: string, input: ExpenseInput, createdAt: number, updatedAt: number): Expense {
    const members = this.members();
    const known = new Set(members.map((m) => m.id));
    if (!known.has(input.payerId)) throw badRequest('payerNotFound');
    const selected = new Set(input.participantIds);
    for (const pid of selected) if (!known.has(pid)) throw badRequest('participantNotFound');
    // 按成员加入顺序排列，保证零头的归属稳定
    const ordered = members.sort(byMemberOrder).filter((m) => selected.has(m.id)).map((m) => m.id);
    return {
      id,
      title: input.title,
      amount: input.amount,
      payerId: input.payerId,
      date: input.date,
      shares: splitEvenly(input.amount, ordered),
      createdAt,
      updatedAt,
    };
  }

  private writeShares(expense: Expense) {
    expense.shares.forEach((s, position) =>
      this.db.run(
        'INSERT INTO expense_shares (expense_id, member_id, amount, position) VALUES (?, ?, ?, ?)',
        expense.id,
        s.memberId,
        s.amount,
        position,
      ),
    );
  }
}

function sameExpense(a: Expense, b: Expense) {
  const shares = (e: Expense) => JSON.stringify(e.shares.map((s) => [s.memberId, s.amount]).sort());
  return a.title === b.title && a.amount === b.amount && a.payerId === b.payerId && a.date === b.date && shares(a) === shares(b);
}
