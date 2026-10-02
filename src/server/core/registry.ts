import type { PassphraseInput } from '../../shared/schema.ts';
import type {
  LedgerInfo,
  LedgerRecord,
  Passphrase,
  RegistryEvent,
  SessionInfo,
  SessionRole,
} from '../../shared/types.ts';
import { AppError, conflict, notFound } from './errors.ts';
import { newId } from './ids.ts';
import { first, migrate, type SqlDriver } from './sql.ts';

const DAY = 86_400_000;
export const SESSION_TTL = {
  /** 永久口令换来的成员会话最长有效期 */
  member: 180 * DAY,
  /** 管理员进入账本时签发的会话 */
  admin: 7 * DAY,
  /** 密码模式下的管理控制台会话 */
  console: 7 * DAY,
} as const;

const MIGRATIONS = [
  `
  CREATE TABLE ledgers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE passphrases (
    id TEXT PRIMARY KEY,
    ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
    code TEXT NOT NULL COLLATE NOCASE,
    valid_from INTEGER NOT NULL,
    valid_until INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX passphrases_code ON passphrases (code);
  CREATE INDEX passphrases_ledger ON passphrases (ledger_id);

  -- 只保存令牌的 SHA-256，数据库泄露也无法冒用会话
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('ledger', 'console')),
    role TEXT NOT NULL,
    ledger_id TEXT REFERENCES ledgers (id) ON DELETE CASCADE,
    passphrase_id TEXT REFERENCES passphrases (id) ON DELETE CASCADE,
    subject TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_expires ON sessions (expires_at);
  `,
];

type LedgerRow = { id: string; name: string; created_at: number; active: number };
type PassphraseRow = {
  id: string;
  ledger_id: string;
  code: string;
  valid_from: number;
  valid_until: number | null;
  created_at: number;
};

const toPassphrase = (r: PassphraseRow): Passphrase => ({
  id: r.id,
  ledgerId: r.ledger_id,
  code: r.code,
  validFrom: r.valid_from,
  validUntil: r.valid_until,
  createdAt: r.created_at,
});

const ACTIVE = '(p.valid_from <= ? AND (p.valid_until IS NULL OR p.valid_until > ?))';

/** 全局注册表：账本列表、分享口令与登录会话。 */
export class RegistryService {
  constructor(
    private readonly db: SqlDriver,
    private readonly emit: (event: RegistryEvent) => void,
  ) {
    migrate(db, MIGRATIONS);
  }

  // ---------- 账本 ----------

  listLedgers(): LedgerRecord[] {
    const now = Date.now();
    return this.db
      .all<LedgerRow>(
        `SELECT l.id, l.name, l.created_at,
                (SELECT COUNT(*) FROM passphrases p WHERE p.ledger_id = l.id AND ${ACTIVE}) AS active
         FROM ledgers l ORDER BY l.created_at DESC`,
        now,
        now,
      )
      .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, activePassphrases: r.active }));
  }

  getLedger(id: string): LedgerInfo {
    const row = first(this.db.all<{ id: string; name: string }>('SELECT id, name FROM ledgers WHERE id = ?', id));
    if (!row) throw notFound('账本不存在');
    return row;
  }

  createLedger(name: string): LedgerRecord {
    this.assertLedgerNameFree(name);
    const ledger = { id: newId(), name, createdAt: Date.now(), activePassphrases: 0 };
    this.db.run('INSERT INTO ledgers (id, name, created_at) VALUES (?, ?, ?)', ledger.id, name, ledger.createdAt);
    this.emit({ type: 'ledgers.changed' });
    return ledger;
  }

  /** 共享模式下使用的固定账本 */
  ensureLedger(id: string, name: string): LedgerInfo {
    this.db.run('INSERT OR IGNORE INTO ledgers (id, name, created_at) VALUES (?, ?, ?)', id, name, Date.now());
    return this.getLedger(id);
  }

  renameLedger(id: string, name: string): LedgerInfo {
    this.getLedger(id);
    this.assertLedgerNameFree(name, id);
    this.db.run('UPDATE ledgers SET name = ? WHERE id = ?', name, id);
    this.emit({ type: 'ledgers.changed' });
    return { id, name };
  }

  deleteLedger(id: string): LedgerInfo {
    const ledger = this.getLedger(id);
    this.db.run('DELETE FROM ledgers WHERE id = ?', id);
    this.emit({ type: 'ledgers.changed' });
    return ledger;
  }

  // ---------- 分享口令 ----------

  listPassphrases(ledgerId: string): Passphrase[] {
    this.getLedger(ledgerId);
    return this.db
      .all<PassphraseRow>('SELECT * FROM passphrases WHERE ledger_id = ? ORDER BY created_at DESC', ledgerId)
      .map(toPassphrase);
  }

  createPassphrase(ledgerId: string, input: PassphraseInput): Passphrase {
    this.getLedger(ledgerId);
    const now = Date.now();
    return this.db.transaction(() => {
      // 同名口令过期后可以复用
      this.db.run('DELETE FROM passphrases WHERE code = ? AND valid_until IS NOT NULL AND valid_until <= ?', input.code, now);
      if (first(this.db.all('SELECT 1 FROM passphrases WHERE code = ?', input.code))) {
        throw conflict('该口令正在使用中，请换一个');
      }
      const passphrase: Passphrase = {
        id: newId(),
        ledgerId,
        code: input.code,
        validFrom: input.validFrom ?? now,
        validUntil: input.validUntil,
        createdAt: now,
      };
      this.db.run(
        'INSERT INTO passphrases (id, ledger_id, code, valid_from, valid_until, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        passphrase.id,
        ledgerId,
        passphrase.code,
        passphrase.validFrom,
        passphrase.validUntil,
        now,
      );
      this.emit({ type: 'passphrases.changed', ledgerId });
      return passphrase;
    });
  }

  /** 撤销口令：通过外键级联，用它登录的会话也会立即失效 */
  revokePassphrase(id: string): Passphrase {
    const row = first(this.db.all<PassphraseRow>('DELETE FROM passphrases WHERE id = ? RETURNING *', id));
    if (!row) throw notFound('口令不存在');
    this.emit({ type: 'passphrases.changed', ledgerId: row.ledger_id });
    return toPassphrase(row);
  }

  // ---------- 会话 ----------

  /** 用口令加入账本，tokenHash 为调用方生成的会话令牌哈希 */
  join(code: string, tokenHash: string): SessionInfo {
    const now = Date.now();
    const rows = this.db.all<PassphraseRow & { name: string }>(
      `SELECT p.*, l.name FROM passphrases p JOIN ledgers l ON l.id = p.ledger_id
       WHERE p.code = ? AND (p.valid_until IS NULL OR p.valid_until > ?)
       ORDER BY p.valid_from`,
      code,
      now,
    );
    const p = rows.find((r) => r.valid_from <= now);
    if (!p) throw new AppError(401, rows.length ? '口令尚未生效' : '口令无效或已过期');
    const expiresAt = Math.min(p.valid_until ?? Infinity, now + SESSION_TTL.member);
    this.insertSession(tokenHash, 'ledger', 'member', p.ledger_id, p.id, null, expiresAt);
    return { ledger: { id: p.ledger_id, name: p.name }, role: 'member', passphrase: p.code, expiresAt };
  }

  /** 管理员直接进入某个账本 */
  openLedgerSession(tokenHash: string, ledgerId: string, subject: string): SessionInfo {
    const ledger = this.getLedger(ledgerId);
    const expiresAt = Date.now() + SESSION_TTL.admin;
    this.insertSession(tokenHash, 'ledger', 'admin', ledgerId, null, subject, expiresAt);
    return { ledger, role: 'admin', passphrase: null, expiresAt };
  }

  openConsoleSession(tokenHash: string, subject: string): number {
    const expiresAt = Date.now() + SESSION_TTL.console;
    this.insertSession(tokenHash, 'console', 'console', null, null, subject, expiresAt);
    return expiresAt;
  }

  resolveLedgerSession(tokenHash: string): SessionInfo | null {
    const row = first(
      this.db.all<{ role: SessionRole; ledger_id: string; name: string; code: string | null; expires_at: number }>(
        `SELECT s.role, s.ledger_id, l.name, p.code, s.expires_at
         FROM sessions s
         JOIN ledgers l ON l.id = s.ledger_id
         LEFT JOIN passphrases p ON p.id = s.passphrase_id
         WHERE s.token_hash = ? AND s.kind = 'ledger' AND s.expires_at > ?`,
        tokenHash,
        Date.now(),
      ),
    );
    if (!row) return null;
    return {
      ledger: { id: row.ledger_id, name: row.name },
      role: row.role,
      passphrase: row.code,
      expiresAt: row.expires_at,
    };
  }

  resolveConsoleSession(tokenHash: string): { subject: string } | null {
    const row = first(
      this.db.all<{ subject: string }>(
        "SELECT subject FROM sessions WHERE token_hash = ? AND kind = 'console' AND expires_at > ?",
        tokenHash,
        Date.now(),
      ),
    );
    return row ?? null;
  }

  endSession(tokenHash: string): void {
    this.db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
  }

  // ---------- 内部工具 ----------

  private insertSession(
    tokenHash: string,
    kind: 'ledger' | 'console',
    role: string,
    ledgerId: string | null,
    passphraseId: string | null,
    subject: string | null,
    expiresAt: number,
  ) {
    const now = Date.now();
    this.db.run('DELETE FROM sessions WHERE expires_at <= ?', now);
    this.db.run(
      `INSERT INTO sessions (token_hash, kind, role, ledger_id, passphrase_id, subject, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      tokenHash,
      kind,
      role,
      ledgerId,
      passphraseId,
      subject,
      expiresAt,
      now,
    );
  }

  private assertLedgerNameFree(name: string, exceptId = '') {
    if (first(this.db.all('SELECT 1 FROM ledgers WHERE name = ? AND id != ?', name, exceptId))) {
      throw conflict(`账本「${name}」已存在`);
    }
  }
}
