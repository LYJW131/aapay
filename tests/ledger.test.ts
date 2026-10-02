import { beforeEach, describe, expect, it } from 'vitest';
import { applyEvent } from '../src/shared/ledger.ts';
import type { LedgerData, LiveMessage } from '../src/shared/types.ts';
import { LedgerService, type MutationContext } from '../src/server/core/ledger.ts';
import { openSqlite } from '../src/server/node/sqlite.ts';

const ctx: MutationContext = { actor: { kind: 'member', passphrase: 'test' } };

describe('LedgerService', () => {
  let service: LedgerService;
  let messages: LiveMessage[];

  beforeEach(() => {
    messages = [];
    service = new LedgerService(openSqlite(':memory:'), (m) => messages.push(m));
  });

  it('records members, expenses and settlements with versioned events', () => {
    const a = (service.createMember({ name: '小明' }, ctx).event as { member: { id: string } }).member.id;
    const b = (service.createMember({ name: '小红', avatar: '🐼' }, ctx).event as { member: { id: string } }).member.id;
    const created = service.createExpense({ title: '晚饭', amount: 1001, payerId: a, date: '2026-10-01', participantIds: [b, a] }, ctx);
    service.createSettlement({ fromId: b, toId: a, amount: 500, date: '2026-10-02' }, ctx);

    const snap = service.snapshot();
    expect(snap.version).toBe(4);
    expect(messages.map((m) => m.v)).toEqual([1, 2, 3, 4]);
    expect(snap.members.map((m) => m.name)).toEqual(['小明', '小红']);
    expect(snap.expenses[0]!.shares).toEqual([
      { memberId: a, amount: 501 },
      { memberId: b, amount: 500 },
    ]);
    expect(snap.settlements).toHaveLength(1);
    expect(created.event.type).toBe('expense.saved');
    expect(service.stats()).toMatchObject({ members: 2, expenses: 1, settlements: 1, total: 1001 });
  });

  it('rejects duplicate names and deleting members with records', () => {
    const a = (service.createMember({ name: 'Amy' }, ctx).event as { member: { id: string } }).member.id;
    expect(() => service.createMember({ name: 'amy' }, ctx)).toThrow('已存在');
    service.createExpense({ title: '咖啡', amount: 100, payerId: a, date: '2026-10-01', participantIds: [a] }, ctx);
    expect(() => service.deleteMember(a, ctx)).toThrow('无法删除');
  });

  it('updates and deletes expenses', () => {
    const a = (service.createMember({ name: 'A' }, ctx).event as { member: { id: string } }).member.id;
    const b = (service.createMember({ name: 'B' }, ctx).event as { member: { id: string } }).member.id;
    const { event } = service.createExpense({ title: '打车', amount: 300, payerId: a, date: '2026-10-01', participantIds: [a] }, ctx);
    const id = (event as { expense: { id: string } }).expense.id;
    service.updateExpense(id, { title: '打车回家', amount: 600, payerId: b, date: '2026-10-02', participantIds: [a, b] }, ctx);
    expect(service.snapshot().expenses[0]).toMatchObject({ title: '打车回家', amount: 600, payerId: b, date: '2026-10-02' });
    service.deleteExpense(id, ctx);
    expect(service.snapshot().expenses).toHaveLength(0);
    expect(() => service.deleteExpense(id, ctx)).toThrow('不存在');
  });

  it('replays events into the same state as a snapshot', () => {
    let data: LedgerData = { version: 0, members: [], expenses: [], settlements: [] };
    const a = (service.createMember({ name: 'A' }, ctx).event as { member: { id: string } }).member.id;
    const b = (service.createMember({ name: 'B' }, ctx).event as { member: { id: string } }).member.id;
    service.createExpense({ title: 'x', amount: 900, payerId: a, date: '2026-09-30', participantIds: [a, b] }, ctx);
    service.createExpense({ title: 'y', amount: 300, payerId: b, date: '2026-10-01', participantIds: [a, b] }, ctx);
    service.createSettlement({ fromId: b, toId: a, amount: 300, date: '2026-10-01', note: '微信' }, ctx);
    for (const m of messages) data = applyEvent(data, m.event, m.v);
    expect(data).toEqual(service.snapshot());
  });
});
