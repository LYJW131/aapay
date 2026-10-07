import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_GENESIS, auditHash, parseAudit, verifyAudit, type AuditRecord } from '../src/shared/audit.ts';
import type { Change } from '../src/shared/changes.ts';
import { newId } from '../src/shared/ids.ts';
import { applyEvent, expenseInputOf } from '../src/shared/ledger.ts';
import type { ExpenseInput, ExpenseSplit } from '../src/shared/schema.ts';
import type { Expense, LedgerData, LiveMessage } from '../src/shared/types.ts';
import { AppError } from '../src/server/core/errors.ts';
import { LedgerService, MIGRATIONS, type MutationContext } from '../src/server/core/ledger.ts';
import { migrate } from '../src/server/core/sql.ts';
import { openSqlite } from '../src/server/node/sqlite.ts';

const dir = mkdtempSync(join(tmpdir(), 'aapay-ledger-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ctx: MutationContext = { actor: { kind: 'member', passphrase: 'test' } };

const addMember = (name: string, avatar?: string): Change => ({ op: 'member.create', id: newId(), member: { name, avatar } });
const even = (...memberIds: string[]): ExpenseSplit => ({ mode: 'even', memberIds });
const exact = (shares: Record<string, number>): ExpenseSplit => ({
  mode: 'exact',
  shares: Object.entries(shares).map(([memberId, amount]) => ({ memberId, amount })),
});
const expenseInput = (payerId: string, split: ExpenseSplit, extra: Partial<ExpenseInput> = {}): ExpenseInput => ({
  title: '晚饭',
  amount: 1000,
  payerId,
  date: '2026-10-01',
  category: 'food',
  split,
  ...extra,
});

function failure(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return { status: err.status, key: err.key };
    throw err;
  }
  throw new Error('expected an AppError');
}

const withoutTimes = ({ createdAt: _, updatedAt: __, ...rest }: Expense) => rest;

describe('LedgerService.applyChanges', () => {
  let service: LedgerService;
  let messages: LiveMessage[];

  beforeEach(() => {
    messages = [];
    service = new LedgerService(openSqlite(':memory:'), (m) => messages.push(m));
  });

  function people(...names: string[]) {
    const changes = names.map((n) => addMember(n));
    service.applyChanges(changes, ctx);
    return changes.map((c) => c.id);
  }

  it('applies a batch in order with one version and one audit record per change', () => {
    const [a, b] = [newId(), newId()];
    const expenseId = newId();
    const result = service.applyChanges(
      [
        { op: 'member.create', id: a, member: { name: '小明' } },
        { op: 'member.create', id: b, member: { name: '小红', avatar: '🐼' } },
        { op: 'expense.create', id: expenseId, expense: expenseInput(a, even(b, a), { amount: 1001 }) },
        { op: 'settlement.create', id: newId(), settlement: { fromId: b, toId: a, amount: 500, date: '2026-10-02' } },
      ],
      ctx,
    );

    expect(result.messages.map((m) => m.v)).toEqual([1, 2, 3, 4]);
    expect(messages).toEqual(result.messages);
    const batch = result.messages[0]!.batch!;
    expect(batch.size).toBe(4);
    expect(result.messages.every((m) => m.batch?.id === batch.id)).toBe(true);
    expect(result.messages.map((m) => m.audit && parseAudit(m.audit).seq)).toEqual([1, 2, 3, 4]);

    const snap = service.snapshot();
    expect(snap.version).toBe(4);
    expect(snap.members.map((m) => m.name)).toEqual(['小明', '小红']);
    expect(snap.expenses[0]).toMatchObject({ id: expenseId, category: 'food' });
    expect(snap.expenses[0]!.shares).toEqual([
      { memberId: a, amount: 501 },
      { memberId: b, amount: 500 },
    ]);
    expect(service.stats()).toMatchObject({ members: 2, expenses: 1, settlements: 1, total: 1001 });
  });

  it('replays events into the same state as a snapshot', () => {
    let data: LedgerData = { version: 0, members: [], expenses: [], settlements: [] };
    const [a, b] = people('A', 'B');
    service.applyChanges(
      [
        { op: 'expense.create', id: newId(), expense: expenseInput(a!, even(a!, b!), { amount: 900, date: '2026-09-30' }) },
        { op: 'expense.create', id: newId(), expense: expenseInput(b!, exact({ [a!]: 100, [b!]: 200 }), { amount: 300, category: null }) },
        { op: 'settlement.create', id: newId(), settlement: { fromId: b!, toId: a!, amount: 300, date: '2026-10-01', note: '微信' } },
      ],
      ctx,
    );
    for (const m of messages) data = applyEvent(data, m.event, m.v);
    expect(data).toEqual(service.snapshot());
  });

  it('rolls back the whole batch and emits nothing when any change fails', () => {
    const [a] = people('A');
    const version = service.snapshot().version;
    const audit = service.auditLog({ after: 0, limit: 500 }).records.length;
    messages.length = 0;
    const before = service.snapshot();

    expect(
      failure(() =>
        service.applyChanges(
          [
            addMember('B'),
            { op: 'expense.create', id: newId(), expense: expenseInput(a!, even(a!)) },
            { op: 'expense.create', id: newId(), expense: expenseInput('missing-payer', even(a!)) },
          ],
          ctx,
        ),
      ),
    ).toEqual({ status: 400, key: 'payerNotFound' });

    expect(service.snapshot()).toEqual(before);
    expect(service.snapshot().version).toBe(version);
    expect(service.auditLog({ after: 0, limit: 500 }).records).toHaveLength(audit);
    expect(messages).toEqual([]);
  });

  it('rejects duplicate names and deleting members with records', () => {
    const [a] = people('Amy');
    expect(failure(() => service.applyChanges([addMember('amy')], ctx))).toEqual({ status: 409, key: 'memberExists' });
    service.applyChanges([{ op: 'expense.create', id: newId(), expense: expenseInput(a!, even(a!)) }], ctx);
    expect(failure(() => service.applyChanges([{ op: 'member.delete', id: a! }], ctx))).toEqual({ status: 409, key: 'memberInUse' });
  });

  it('refuses a pre-allocated id that already exists', () => {
    const [a] = people('A');
    expect(failure(() => service.applyChanges([{ op: 'member.create', id: a!, member: { name: 'B' } }], ctx))).toEqual({
      status: 409,
      key: 'idExists',
    });
    const expenseId = newId();
    service.applyChanges([{ op: 'expense.create', id: expenseId, expense: expenseInput(a!, even(a!)) }], ctx);
    expect(failure(() => service.applyChanges([{ op: 'expense.create', id: expenseId, expense: expenseInput(a!, even(a!)) }], ctx))).toEqual({
      status: 409,
      key: 'idExists',
    });
    const settlementId = newId();
    const [b] = people('B');
    const settle: Change = { op: 'settlement.create', id: settlementId, settlement: { fromId: a!, toId: b!, amount: 1, date: '2026-10-01' } };
    service.applyChanges([settle], ctx);
    expect(failure(() => service.applyChanges([settle], ctx))).toEqual({ status: 409, key: 'idExists' });
  });

  it('validates custom splits', () => {
    const [a, b] = people('A', 'B');
    const create = (split: ExpenseSplit, amount = 1000) => () =>
      service.applyChanges([{ op: 'expense.create', id: newId(), expense: expenseInput(a!, split, { amount }) }], ctx);
    expect(failure(create(exact({ [a!]: 400, [b!]: 500 })))).toEqual({ status: 400, key: 'sharesSumMismatch' });
    expect(failure(create({ mode: 'exact', shares: [{ memberId: a!, amount: 500 }, { memberId: a!, amount: 500 }] }))).toEqual({
      status: 400,
      key: 'sharesDuplicate',
    });
    expect(failure(create(exact({ [a!]: 1000, [b!]: 0 })))).toEqual({ status: 400, key: 'shareNotPositive' });
    expect(failure(create(exact({ [a!]: 500, nobody123: 500 })))).toEqual({ status: 400, key: 'participantNotFound' });
    expect(failure(create(even()))).toEqual({ status: 400, key: 'participantsRequired' });
    expect(failure(() => service.applyChanges([{ op: 'expense.create', id: 'bad id!', expense: expenseInput(a!, even(a!)) }], ctx))).toEqual({
      status: 400,
      key: 'idInvalid',
    });

    const id = newId();
    service.applyChanges([{ op: 'expense.create', id, expense: expenseInput(b!, exact({ [b!]: 700, [a!]: 300 })) }], ctx);
    expect(service.snapshot().expenses[0]!.shares).toEqual([
      { memberId: a, amount: 300 },
      { memberId: b, amount: 700 },
    ]);
  });

  it('persists categories and compares every share when detecting changes', () => {
    const [a, b] = people('A', 'B');
    const id = newId();
    service.applyChanges([{ op: 'expense.create', id, expense: expenseInput(a!, even(a!, b!)) }], ctx);
    const sent = messages.length;

    expect(service.applyChanges([{ op: 'expense.update', id, expense: expenseInput(a!, even(b!, a!)) }], ctx)).toEqual({ messages: [], undo: [] });
    expect(messages).toHaveLength(sent);

    service.applyChanges([{ op: 'expense.update', id, expense: expenseInput(a!, even(a!, b!), { category: 'fun' }) }], ctx);
    expect(service.snapshot().expenses[0]!.category).toBe('fun');
    service.applyChanges([{ op: 'expense.update', id, expense: expenseInput(a!, exact({ [a!]: 400, [b!]: 600 }), { category: 'fun' }) }], ctx);
    expect(service.snapshot().expenses[0]!.shares.map((s) => s.amount)).toEqual([400, 600]);
    expect(service.snapshot().version).toBe(5);
  });

  it('checks ifUpdatedAt before updating or deleting an expense', () => {
    const [a] = people('A');
    const id = newId();
    service.applyChanges([{ op: 'expense.create', id, expense: expenseInput(a!, even(a!)) }], ctx);
    const seen = service.snapshot().expenses[0]!.updatedAt;
    service.applyChanges([{ op: 'expense.update', id, expense: expenseInput(a!, even(a!), { title: '别人改的' }), ifUpdatedAt: seen }], ctx);
    const latest = service.snapshot().expenses[0]!.updatedAt;
    expect(latest).toBeGreaterThan(seen);

    expect(failure(() => service.applyChanges([{ op: 'expense.update', id, expense: expenseInput(a!, even(a!)), ifUpdatedAt: seen }], ctx))).toEqual({
      status: 409,
      key: 'changeConflict',
    });
    expect(failure(() => service.applyChanges([{ op: 'expense.delete', id, ifUpdatedAt: seen }], ctx))).toEqual({ status: 409, key: 'changeConflict' });
    service.applyChanges([{ op: 'expense.delete', id, ifUpdatedAt: latest }], ctx);
    expect(service.snapshot().expenses).toHaveLength(0);
    expect(failure(() => service.applyChanges([{ op: 'expense.delete', id }], ctx))).toEqual({ status: 404, key: 'expenseNotFound' });
  });

  it('labels assistant changes in messages and the audit log', () => {
    service.applyChanges([addMember('A'), addMember('B')], { ...ctx, origin: 'tab', via: 'assistant' });
    expect(messages.map((m) => [m.origin, m.via, m.batch?.size])).toEqual([
      ['tab', 'assistant', 2],
      ['tab', 'assistant', 2],
    ]);
    expect(parseAudit(messages[0]!.audit!).via).toBe('assistant');
    service.applyChanges([addMember('C')], ctx);
    expect(messages.at(-1)!.via).toBeUndefined();
    expect(parseAudit(messages.at(-1)!.audit!)).not.toHaveProperty('via');
  });
});

describe('LedgerService.previewChanges', () => {
  it('returns the resulting data without writing, versioning, auditing or emitting', () => {
    const messages: LiveMessage[] = [];
    const service = new LedgerService(openSqlite(':memory:'), (m) => messages.push(m));
    const a = newId();
    service.applyChanges([{ op: 'member.create', id: a, member: { name: 'A', avatar: '🐱' } }], ctx);
    const before = service.snapshot();
    const audit = service.auditLog({ after: 0, limit: 500 }).records.length;
    messages.length = 0;

    const b = newId();
    const changes: Change[] = [
      { op: 'member.create', id: b, member: { name: 'B', avatar: '🐶' } },
      { op: 'expense.create', id: newId(), expense: expenseInput(a, even(a, b)) },
    ];
    const preview = service.previewChanges(changes);
    expect(preview.version).toBe(before.version);
    expect(preview.members.map((m) => m.name)).toEqual(['A', 'B']);
    expect(preview.expenses[0]!.shares).toEqual([
      { memberId: a, amount: 500 },
      { memberId: b, amount: 500 },
    ]);
    expect(service.snapshot()).toEqual(before);
    expect(service.auditLog({ after: 0, limit: 500 }).records).toHaveLength(audit);
    expect(messages).toEqual([]);

    const applied = service.applyChanges(changes, ctx);
    const after = service.snapshot();
    expect(after.version).toBe(before.version + 2);
    expect(after.expenses.map(withoutTimes)).toEqual(preview.expenses.map(withoutTimes));
    expect(applied.messages).toHaveLength(2);

    const bad: Change[] = [{ op: 'member.delete', id: a }];
    expect(failure(() => service.previewChanges(bad))).toEqual(failure(() => service.applyChanges(bad, ctx)));
  });
});

describe('undo', () => {
  let service: LedgerService;

  beforeEach(() => {
    service = new LedgerService(openSqlite(':memory:'), () => undefined);
  });

  const state = () => {
    const { members, expenses, settlements } = service.snapshot();
    return {
      members: members.map(({ createdAt: _, ...m }) => m),
      expenses: expenses.map(withoutTimes),
      settlements: settlements.map(({ createdAt: _, ...s }) => s),
    };
  };

  it('restores a batch that created a member and an expense using that member', () => {
    const a = newId();
    service.applyChanges([{ op: 'member.create', id: a, member: { name: 'A', avatar: '🐱' } }], ctx);
    const original = state();
    const b = newId();
    const { undo } = service.applyChanges(
      [
        { op: 'member.create', id: b, member: { name: 'B', avatar: '🐶' } },
        { op: 'expense.create', id: newId(), expense: expenseInput(b, even(a, b)) },
      ],
      ctx,
    );
    expect(undo.map((c) => c.op)).toEqual(['expense.delete', 'member.delete']);
    service.applyChanges(undo, ctx);
    expect(state()).toEqual(original);
  });

  it('brings back deleted records with the same id, category and custom split', () => {
    const [a, b] = [newId(), newId()];
    const expenseId = newId();
    const settlementId = newId();
    service.applyChanges(
      [
        { op: 'member.create', id: a, member: { name: 'A', avatar: '🐱' } },
        { op: 'member.create', id: b, member: { name: 'B', avatar: '🐶' } },
        { op: 'member.create', id: newId(), member: { name: 'C', avatar: '🦊' } },
        { op: 'expense.create', id: expenseId, expense: expenseInput(a, exact({ [a]: 300, [b]: 700 }), { category: 'lodging' }) },
        { op: 'settlement.create', id: settlementId, settlement: { fromId: b, toId: a, amount: 200, date: '2026-10-02', note: '转账' } },
      ],
      ctx,
    );
    const original = state();
    const c = service.snapshot().members[2]!.id;
    const { undo } = service.applyChanges(
      [
        { op: 'expense.delete', id: expenseId },
        { op: 'settlement.delete', id: settlementId },
        { op: 'member.delete', id: c },
      ],
      ctx,
    );
    expect(state().expenses).toHaveLength(0);
    service.applyChanges(undo, ctx);
    expect(state()).toEqual(original);
  });

  it('reverts updates, including several updates to the same expense in one batch', () => {
    const [a, b] = [newId(), newId()];
    const id = newId();
    service.applyChanges(
      [
        { op: 'member.create', id: a, member: { name: 'A', avatar: '🐱' } },
        { op: 'member.create', id: b, member: { name: 'B', avatar: '🐶' } },
        { op: 'expense.create', id, expense: expenseInput(a, even(a, b)) },
      ],
      ctx,
    );
    const original = state();
    const { undo } = service.applyChanges(
      [
        { op: 'expense.update', id, expense: expenseInput(a, even(a), { title: '第一次' }) },
        { op: 'expense.update', id, expense: expenseInput(b, exact({ [a]: 100, [b]: 900 }), { title: '第二次', category: 'fun' }) },
        { op: 'member.update', id: a, member: { name: 'A2', avatar: '🐯' } },
      ],
      ctx,
    );
    expect(undo.map((c) => [c.op, 'ifUpdatedAt' in c])).toEqual([
      ['member.update', false],
      ['expense.update', true],
      ['expense.update', false],
    ]);
    service.applyChanges(undo, ctx);
    expect(state()).toEqual(original);
  });

  it('undoes a create followed by an update of the same expense', () => {
    const a = newId();
    service.applyChanges([{ op: 'member.create', id: a, member: { name: 'A', avatar: '🐱' } }], ctx);
    const original = state();
    const id = newId();
    const { undo } = service.applyChanges(
      [
        { op: 'expense.create', id, expense: expenseInput(a, even(a)) },
        { op: 'expense.update', id, expense: expenseInput(a, even(a), { amount: 2000 }) },
      ],
      ctx,
    );
    service.applyChanges(undo, ctx);
    expect(state()).toEqual(original);
  });

  it('refuses to undo over a newer edit by someone else', () => {
    const a = newId();
    const id = newId();
    service.applyChanges(
      [
        { op: 'member.create', id: a, member: { name: 'A', avatar: '🐱' } },
        { op: 'expense.create', id, expense: expenseInput(a, even(a)) },
      ],
      ctx,
    );
    const { undo } = service.applyChanges([{ op: 'expense.update', id, expense: expenseInput(a, even(a), { title: '我改的' }) }], ctx);
    service.applyChanges([{ op: 'expense.update', id, expense: expenseInput(a, even(a), { title: '别人又改了' }) }], ctx);
    expect(failure(() => service.applyChanges(undo, ctx))).toEqual({ status: 409, key: 'changeConflict' });
    expect(service.snapshot().expenses[0]!.title).toBe('别人又改了');
  });

  it.each([
    ['updating', (x: string, a: string, b: string): Change => ({ op: 'expense.update', id: x, expense: expenseInput(a, even(a, b), { amount: 101 }) })],
    ['deleting', (x: string): Change => ({ op: 'expense.delete', id: x })],
  ])('restores each share exactly after %s an even split and deleting a participant in one batch', (_, change) => {
    const [a, m, b, x] = [newId(), newId(), newId(), newId()];
    service.applyChanges(
      [
        { op: 'member.create', id: a, member: { name: 'A' } },
        { op: 'member.create', id: m, member: { name: 'M' } },
        { op: 'member.create', id: b, member: { name: 'B' } },
        { op: 'expense.create', id: x, expense: expenseInput(a, even(a, m, b), { amount: 101 }) },
      ],
      ctx,
    );
    const perPerson = () => Object.fromEntries(service.snapshot().expenses[0]!.shares.map((s) => [s.memberId, s.amount]));
    expect(perPerson()).toEqual({ [a]: 34, [m]: 34, [b]: 33 });
    const { undo } = service.applyChanges([change(x, a, b), { op: 'member.delete', id: m }], ctx);
    service.applyChanges(undo, ctx);
    expect(perPerson()).toEqual({ [a]: 34, [m]: 34, [b]: 33 });
  });

  it('turns stored expenses back into inputs with their exact shares, unless a share is zero', () => {
    const [a, b, c] = [newId(), newId(), newId()];
    service.applyChanges(
      [
        { op: 'member.create', id: a, member: { name: 'A' } },
        { op: 'member.create', id: b, member: { name: 'B' } },
        { op: 'member.create', id: c, member: { name: 'C' } },
        { op: 'expense.create', id: newId(), expense: expenseInput(a, even(c, a, b), { amount: 1000 }) },
        { op: 'expense.create', id: newId(), expense: expenseInput(a, exact({ [c]: 500, [a]: 500 }), { amount: 1000, date: '2026-09-01' }) },
        { op: 'expense.create', id: newId(), expense: expenseInput(a, even(a, b, c), { amount: 2, date: '2026-08-01' }) },
      ],
      ctx,
    );
    const { members, expenses } = service.snapshot();
    expect(expenseInputOf(expenses[0]!, members).split).toEqual(exact({ [a]: 334, [b]: 333, [c]: 333 }));
    expect(expenseInputOf(expenses[1]!, members).split).toEqual(exact({ [a]: 500, [c]: 500 }));
    expect(expenseInputOf(expenses[2]!, members).split).toEqual(even(a, b, c));
  });
});

describe('ledger migration', () => {
  it('adds categories to an existing ledger without touching its rows or audit chain', () => {
    const db = openSqlite(join(dir, `${crypto.randomUUID()}.db`));
    migrate(db, MIGRATIONS.slice(0, 2));
    db.run("UPDATE meta SET value = 3 WHERE key = 'version'");
    db.run("INSERT INTO members (id, name, avatar, created_at) VALUES ('member000001', '阿杰', '🦊', 1), ('member000002', '小雨', '🐼', 2)");
    db.run("INSERT INTO expenses (id, title, amount, payer_id, date, created_at, updated_at) VALUES ('expense00001', '晚饭', 1001, 'member000001', '2026-10-01', 10, 10)");
    db.run("INSERT INTO expense_shares (expense_id, member_id, amount, position) VALUES ('expense00001', 'member000001', 501, 0), ('expense00001', 'member000002', 500, 1)");
    db.run("INSERT INTO settlements (id, from_id, to_id, amount, date, note, created_at) VALUES ('settle000001', 'member000002', 'member000001', 500, '2026-10-02', NULL, 20)");
    let prev = AUDIT_GENESIS;
    const actor = { kind: 'member', passphrase: 'old' };
    const actions = [
      { type: 'member.create', name: '阿杰', avatar: '🦊' },
      { type: 'expense.create', expense: { id: 'expense00001', title: '晚饭', amount: 1001, payer: '阿杰', participants: ['阿杰', '小雨'], date: '2026-10-01' } },
      { type: 'settlement.create', settlement: { id: 'settle000001', from: '小雨', to: '阿杰', amount: 500, date: '2026-10-02', note: null } },
    ];
    actions.forEach((action, i) => {
      const payload = JSON.stringify({ seq: i + 1, at: 100 + i, actor, action });
      const hash = auditHash(prev, payload);
      db.run('INSERT INTO audit_log (seq, payload, prev, hash, sig) VALUES (?, ?, ?, ?, NULL)', i + 1, payload, prev, hash);
      prev = hash;
    });

    const service = new LedgerService(db, () => undefined);
    const snap = service.snapshot();
    expect(snap.version).toBe(3);
    expect(snap.members.map((m) => m.name)).toEqual(['阿杰', '小雨']);
    expect(snap.expenses).toEqual([
      {
        id: 'expense00001',
        title: '晚饭',
        amount: 1001,
        payerId: 'member000001',
        date: '2026-10-01',
        category: null,
        shares: [
          { memberId: 'member000001', amount: 501 },
          { memberId: 'member000002', amount: 500 },
        ],
        createdAt: 10,
        updatedAt: 10,
      },
    ]);
    expect(snap.settlements).toHaveLength(1);

    const records = (): AuditRecord[] => service.auditLog({ after: 0, limit: 500 }).records;
    expect(verifyAudit(records(), null, null)).toMatchObject({ ok: true, checkpoint: { seq: 3 } });
    service.applyChanges([{ op: 'expense.update', id: 'expense00001', expense: { ...expenseInputOf(snap.expenses[0]!, snap.members), category: 'food' } }], ctx);
    expect(service.snapshot().expenses[0]!.category).toBe('food');
    expect(verifyAudit(records(), null, null)).toMatchObject({ ok: true, checkpoint: { seq: 4 } });
  });

  it('moves expenses filed under removed categories to other', () => {
    const db = openSqlite(join(dir, `${crypto.randomUUID()}.db`));
    migrate(db, MIGRATIONS.slice(0, 3));
    db.run("INSERT INTO members (id, name, avatar, created_at) VALUES ('member000001', '阿杰', '🦊', 1)");
    for (const [id, category] of [['expense00001', 'health'], ['expense00002', 'gifts'], ['expense00003', 'food']]) {
      db.run("INSERT INTO expenses (id, title, amount, payer_id, date, created_at, updated_at, category) VALUES (?, 'x', 100, 'member000001', '2026-10-01', 1, 1, ?)", id!, category!);
    }
    const categories = new LedgerService(db, () => undefined).snapshot().expenses.map((e) => [e.id, e.category]);
    expect(Object.fromEntries(categories)).toEqual({ expense00001: 'other', expense00002: 'other', expense00003: 'food' });
  });
});
