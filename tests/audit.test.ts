import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { UpgradeWebSocket } from 'hono/ws';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { createSigner } from '../src/server/core/audit.ts';
import { LedgerService, type MutationContext } from '../src/server/core/ledger.ts';
import { loadConfig } from '../src/server/config.ts';
import { createNodePlatform } from '../src/server/node/platform.ts';
import { openSqlite } from '../src/server/node/sqlite.ts';
import { actorLabel, describeAudit } from '../src/shared/audit-text.ts';
import { AUDIT_GENESIS, auditHash, parseAudit, verifyAudit, type AuditRecord } from '../src/shared/audit.ts';
import { newId } from '../src/shared/ids.ts';
import type { ExpenseInput } from '../src/shared/schema.ts';
import type { LiveMessage } from '../src/shared/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'aapay-audit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const seed = ed25519.utils.randomSecretKey();
const signer = createSigner(seed);
const member: MutationContext = { actor: { kind: 'member', passphrase: 'trip' } };

function service() {
  const db = openSqlite(join(dir, `${crypto.randomUUID()}.db`));
  const messages: LiveMessage[] = [];
  return { db, messages, svc: new LedgerService(db, (m) => messages.push(m), signer) };
}

const dinner = (payerId: string, amount: number, memberIds: string[]): ExpenseInput => ({
  title: '晚饭',
  amount,
  payerId,
  date: '2026-10-01',
  category: 'food',
  split: { mode: 'even', memberIds },
});

function seedLedger(svc: LedgerService) {
  const [a, b, id] = [newId(), newId(), newId()];
  svc.applyChanges([{ op: 'member.create', id: a, member: { name: '阿杰' } }], member);
  svc.applyChanges([{ op: 'member.create', id: b, member: { name: '小雨' } }], member);
  svc.applyChanges([{ op: 'expense.create', id, expense: dinner(a, 12000, [a, b]) }], member);
  svc.applyChanges([{ op: 'expense.update', id, expense: dinner(b, 15000, [a, b]) }], member);
  svc.applyChanges([{ op: 'settlement.create', id: newId(), settlement: { fromId: a, toId: b, amount: 7500, date: '2026-10-02' } }], member);
  return { a, b, id };
}

const allRecords = (svc: LedgerService) => svc.auditLog({ after: 0, limit: 500 }).records;

describe('audit log (service)', () => {
  it('writes a signed hash chain in the same transaction as every change', () => {
    const { svc, messages } = service();
    seedLedger(svc);
    const records = allRecords(svc);
    expect(records.map((r) => parseAudit(r).action.type)).toEqual([
      'member.create',
      'member.create',
      'expense.create',
      'expense.update',
      'settlement.create',
    ]);
    expect(records[0]!.prev).toBe(AUDIT_GENESIS);
    expect(verifyAudit(records, signer.publicKey, null)).toMatchObject({ ok: true, signed: true, checkpoint: { seq: 5 } });
    expect(messages.every((m) => m.audit)).toBe(true);
    expect(messages.at(-1)!.audit!.hash).toBe(records.at(-1)!.hash);

    const update = parseAudit(records[3]!);
    expect(actorLabel(update.actor, 'zh-CN')).toBe('成员（口令 trip）');
    expect(describeAudit(update.action, 'zh-CN').details).toEqual(['金额：¥120.00 → ¥150.00', '付款人：阿杰 → 小雨']);
  });

  it('rolls back the log when the change fails, and keeps names after members are gone', () => {
    const { svc } = service();
    const { a } = seedLedger(svc);
    expect(() => svc.applyChanges([{ op: 'member.delete', id: a }], member)).toThrow('无法删除');
    expect(allRecords(svc)).toHaveLength(5);
  });

  it('skips unchanged updates without bumping the version or writing the log', () => {
    const { svc, messages } = service();
    const { a, b, id } = seedLedger(svc);
    const version = svc.snapshot().version;
    const sent = messages.length;
    const result = svc.applyChanges(
      [
        { op: 'expense.update', id, expense: dinner(b, 15000, [b, a]) },
        { op: 'member.update', id: a, member: { name: '阿杰' } },
      ],
      member,
    );
    expect(result).toEqual({ messages: [], undo: [] });
    expect(svc.snapshot().version).toBe(version);
    expect(messages).toHaveLength(sent);
    expect(allRecords(svc)).toHaveLength(5);
  });

  it('describes categories, custom splits and assistant changes in both languages', () => {
    const { svc } = service();
    const { a, b, id } = seedLedger(svc);
    svc.applyChanges(
      [
        {
          op: 'expense.update',
          id,
          expense: { ...dinner(b, 15000, []), category: 'fun', split: { mode: 'exact', shares: [{ memberId: a, amount: 5000 }, { memberId: b, amount: 10000 }] } },
        },
        {
          op: 'expense.create',
          id: newId(),
          expense: { ...dinner(a, 9000, []), title: '民宿', category: 'lodging', split: { mode: 'exact', shares: [{ memberId: a, amount: 3000 }, { memberId: b, amount: 6000 }] } },
        },
      ],
      { ...member, via: 'assistant' },
    );
    const [update, create] = allRecords(svc).slice(-2).map(parseAudit);
    expect(describeAudit(update!.action, 'zh-CN').details).toEqual([
      '分类：🍜 餐饮 → 🎉 娱乐',
      '分摊：阿杰、小雨 → 阿杰 ¥50.00、小雨 ¥100.00',
    ]);
    expect(describeAudit(update!.action, 'en').details).toEqual([
      'Category: 🍜 Food & drinks → 🎉 Entertainment',
      'Split: 阿杰, 小雨 → 阿杰 ¥50.00, 小雨 ¥100.00',
    ]);
    expect(describeAudit(create!.action, 'zh-CN')).toEqual({
      summary: '记了一笔「民宿」¥90.00，阿杰 付，2 人按金额分摊（2026-10-01）',
      details: ['分类：🏨 住宿', '分摊：阿杰 ¥30.00、小雨 ¥60.00'],
    });
    expect(describeAudit(create!.action, 'en').summary).toBe('Added “民宿” ¥90.00, paid by 阿杰, custom split 2 ways (2026-10-01)');
    expect(actorLabel(create!.actor, 'zh-CN', create!.via)).toBe('成员（口令 trip） · 经 AI 助手');
    expect(actorLabel(create!.actor, 'en', create!.via)).toBe('Member (passcode trip) · via AI assistant');

    const legacy = { id: 'x', title: '旧账', amount: 100, payer: '阿杰', participants: ['阿杰'], date: '2026-01-01' };
    expect(describeAudit({ type: 'expense.update', before: legacy, after: { ...legacy, amount: 200 } }, 'zh-CN').details).toEqual(['金额：¥1.00 → ¥2.00']);
    expect(describeAudit({ type: 'expense.create', expense: legacy }, 'en').details).toEqual([]);
    expect(verifyAudit(allRecords(svc), signer.publicKey, null).ok).toBe(true);
  });

  it('refuses to update or delete log rows', () => {
    const { db, svc } = service();
    seedLedger(svc);
    expect(() => db.run("UPDATE audit_log SET payload = '{}' WHERE seq = 1")).toThrow('append-only');
    expect(() => db.run('DELETE FROM audit_log WHERE seq = 1')).toThrow('append-only');
  });

  it('detects tampering by someone with direct database access', () => {
    const { db, svc } = service();
    seedLedger(svc);
    db.exec('DROP TRIGGER audit_log_no_update');

    const forged = allRecords(svc).map((r) => ({ ...r }));
    const target = forged[2]!;
    target.payload = target.payload.replace('12000', '1200');
    expect(verifyAudit(forged, signer.publicKey, null)).toMatchObject({ ok: false, seq: 3, reason: 'hash-mismatch' });

    let prev = AUDIT_GENESIS;
    for (const r of forged) {
      r.prev = prev;
      r.hash = auditHash(prev, r.payload);
      prev = r.hash;
    }
    expect(verifyAudit(forged, signer.publicKey, null)).toMatchObject({ ok: false, seq: 3, reason: 'bad-signature' });
    expect(verifyAudit(forged, null, null).ok).toBe(true);
  });

  it('lets a browser checkpoint catch a rewritten history even without signatures', () => {
    const { svc } = service();
    seedLedger(svc);
    const seen = verifyAudit(allRecords(svc).slice(0, 3), null, null);
    expect(seen.ok).toBe(true);
    const checkpoint = seen.ok ? seen.checkpoint : null;

    const rewritten: AuditRecord[] = [];
    let prev = AUDIT_GENESIS;
    for (const r of allRecords(svc)) {
      const payload = r.seq === 2 ? r.payload.replace('小雨', '小王') : r.payload;
      const hash = auditHash(prev, payload);
      rewritten.push({ ...r, payload, prev, hash, sig: null });
      prev = hash;
    }
    expect(verifyAudit(rewritten.slice(3), null, checkpoint)).toMatchObject({ ok: false, seq: 4, reason: 'prev-mismatch' });
    expect(verifyAudit(allRecords(svc).slice(3), signer.publicKey, checkpoint).ok).toBe(true);
    expect(verifyAudit(allRecords(svc).slice(3), signer.publicKey, { ...checkpoint!, publicKey: 'ff'.repeat(32) })).toMatchObject({
      ok: false,
      reason: 'key-changed',
    });
  });

  it('pages backwards and forwards', () => {
    const { svc } = service();
    seedLedger(svc);
    const latest = svc.auditLog({ limit: 2 });
    expect(latest.records.map((r) => r.seq)).toEqual([5, 4]);
    expect(latest.head).toMatchObject({ seq: 5 });
    expect(svc.auditLog({ before: 4, limit: 2 }).records.map((r) => r.seq)).toEqual([3, 2]);
    expect(svc.auditLog({ after: 3, limit: 10 }).records.map((r) => r.seq)).toEqual([4, 5]);
  });
});

describe('audit log (app)', () => {
  it('attributes every change to the identity the server verified', async () => {
    const config = loadConfig({ ADMIN_AUTH: 'none' });
    const platform = createNodePlatform(join(dir, crypto.randomUUID()), (() => undefined) as unknown as UpgradeWebSocket, seed);
    const app = createApp(async (c, next) => {
      c.set('config', config);
      c.set('platform', platform);
      await next();
    });
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.request(`http://aapay.test${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.getSetCookie()[0];
      if (set) cookie = set.split(';')[0]!;
      const text = await res.text();
      return (text ? JSON.parse(text) : null) as any;
    };

    await call('GET', '/api/admin/login');
    const ledger = await call('POST', '/api/admin/ledgers', { name: '露营' });
    await call('POST', `/api/admin/ledgers/${ledger.id}/passphrases`, { code: 'camp88', validUntil: null });
    await call('PATCH', `/api/admin/ledgers/${ledger.id}`, { name: '周末露营' });
    await call('POST', '/api/join', { code: 'CAMP88' });
    await call('POST', '/api/ledger/changes', { changes: [{ op: 'member.create', id: newId(), member: { name: '阿杰' } }] }, { 'x-client-id': 'forged-admin' });

    const page = await call('GET', '/api/ledger/audit?limit=10');
    expect(page.publicKey).toBe(signer.publicKey);
    const entries = (page.records as AuditRecord[]).map(parseAudit).reverse();
    expect(entries.map((e) => [e.action.type, actorLabel(e.actor, 'zh-CN')])).toEqual([
      ['ledger.create', '管理员 developer'],
      ['passphrase.create', '管理员 developer'],
      ['ledger.update', '管理员 developer'],
      ['member.create', '成员（口令 camp88）'],
    ]);
    expect(verifyAudit([...page.records].reverse(), page.publicKey, null).ok).toBe(true);
  });
});
