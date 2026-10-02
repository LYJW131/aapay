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
];

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

/**
 * 单个账本的全部业务逻辑。每个账本拥有独立的 SQLite 数据库：
 * Cloudflare 上是一个 Durable Object，Docker 中是 data/ledgers/<id>.db。
 */
export class LedgerService {
  constructor(
    private readonly db: SqlDriver,
    private readonly emit: (message: LiveMessage) => void,
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

  // ---------- 成员 ----------

  createMember(input: MemberInput, origin?: string) {
    return this.commit(origin, () => {
      if (this.count('members') >= LIMITS.members) throw badRequest(`成员最多 ${LIMITS.members} 位`);
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
      return { type: 'member.saved', member };
    });
  }

  updateMember(id: string, input: MemberInput, origin?: string) {
    return this.commit(origin, () => {
      const current = this.member(id);
      this.assertNameFree(input.name, id);
      const member: Member = { ...current, name: input.name, avatar: input.avatar || current.avatar };
      this.db.run('UPDATE members SET name = ?, avatar = ? WHERE id = ?', member.name, member.avatar, id);
      return { type: 'member.saved', member };
    });
  }

  deleteMember(id: string, origin?: string) {
    return this.commit(origin, () => {
      this.member(id);
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
      if (used) throw conflict('该成员已有相关账目，无法删除');
      this.db.run('DELETE FROM members WHERE id = ?', id);
      return { type: 'member.deleted', id };
    });
  }

  // ---------- 支出 ----------

  createExpense(input: ExpenseInput, origin?: string) {
    return this.commit(origin, () => {
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
      return { type: 'expense.saved', expense };
    });
  }

  updateExpense(id: string, input: ExpenseInput, origin?: string) {
    return this.commit(origin, () => {
      const current = first(this.db.all<ExpenseRow>('SELECT * FROM expenses WHERE id = ?', id));
      if (!current) throw notFound('这笔支出不存在或已被删除');
      const expense = this.buildExpense(id, input, current.created_at, Date.now());
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
      return { type: 'expense.saved', expense };
    });
  }

  deleteExpense(id: string, origin?: string) {
    return this.commit(origin, () => {
      if (!first(this.db.all('DELETE FROM expenses WHERE id = ? RETURNING id', id))) {
        throw notFound('这笔支出不存在或已被删除');
      }
      return { type: 'expense.deleted', id };
    });
  }

  // ---------- 还款 ----------

  createSettlement(input: SettlementInput, origin?: string) {
    return this.commit(origin, () => {
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
      return { type: 'settlement.saved', settlement };
    });
  }

  deleteSettlement(id: string, origin?: string) {
    return this.commit(origin, () => {
      if (!first(this.db.all('DELETE FROM settlements WHERE id = ? RETURNING id', id))) {
        throw notFound('这笔还款不存在或已被删除');
      }
      return { type: 'settlement.deleted', id };
    });
  }

  /** 推送与账目无关的通知（改名、关闭），不改变版本号 */
  notify(event: LedgerEvent) {
    this.emit({ event, at: Date.now() });
  }

  // ---------- 内部工具 ----------

  private commit(origin: string | undefined, mutate: () => LedgerEvent): LiveMessage {
    const message = this.db.transaction(() => {
      const event = mutate();
      const { value } = first(
        this.db.all<{ value: number }>("UPDATE meta SET value = value + 1 WHERE key = 'version' RETURNING value"),
      )!;
      return { v: value, origin, event, at: Date.now() } satisfies LiveMessage;
    });
    this.emit(message);
    return message;
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
    if (!row) throw notFound('成员不存在');
    return toMember(row);
  }

  private assertNameFree(name: string, exceptId = '') {
    if (first(this.db.all('SELECT 1 FROM members WHERE name = ? AND id != ?', name, exceptId))) {
      throw conflict(`成员「${name}」已存在`);
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
    if (!known.has(input.payerId)) throw badRequest('付款人不存在');
    const selected = new Set(input.participantIds);
    for (const pid of selected) if (!known.has(pid)) throw badRequest('参与者不存在');
    // 按成员加入顺序排列，保证分摊结果（尤其是零头的归属）稳定可预期
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
