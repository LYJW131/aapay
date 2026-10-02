import type { PassphraseInput } from '../../shared/schema.ts';
import type {
  Connection,
  LedgerInfo,
  LedgerRecord,
  McpScope,
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

export const OAUTH_TTL = {
  /** 授权码只能使用一次，且必须很快兑换 */
  code: 5 * 60_000,
  /** MCP 访问令牌 */
  access: 60 * 60_000,
  /** 一次授权（刷新令牌）的最长有效期，同时不会超过口令本身的有效期 */
  grant: 180 * DAY,
  /** 长期无授权的动态注册客户端会被清理 */
  idleClient: 30 * DAY,
  /** 客户端元数据文档（CIMD）的缓存时间 */
  metadata: DAY,
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
  `
  -- OAuth 2.1 客户端：动态注册（dcr）或以元数据文档 URL 作为 client_id（cimd）
  CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('dcr', 'cimd')),
    name TEXT,
    uri TEXT,
    redirect_uris TEXT NOT NULL,
    secret_hash TEXT,
    created_at INTEGER NOT NULL,
    fetched_at INTEGER,
    last_used_at INTEGER NOT NULL
  );

  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
    ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
    passphrase_id TEXT REFERENCES passphrases (id) ON DELETE CASCADE,
    subject TEXT,
    redirect_uri TEXT NOT NULL,
    challenge TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    grant_expires_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- 一次授权 = 一个已连接的 AI 应用；撤销口令或删除账本时级联失效
  CREATE TABLE oauth_grants (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
    ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
    passphrase_id TEXT REFERENCES passphrases (id) ON DELETE CASCADE,
    subject TEXT,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    refresh_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX oauth_grants_ledger ON oauth_grants (ledger_id);
  CREATE INDEX oauth_grants_client ON oauth_grants (client_id);

  CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);
  CREATE INDEX oauth_tokens_expires ON oauth_tokens (expires_at);
  `,
  `
  -- private_key_jwt 客户端认证：客户端公布的 JWKS 地址；以及是否允许不带凭证的公共客户端
  ALTER TABLE oauth_clients ADD COLUMN jwks_uri TEXT;
  ALTER TABLE oauth_clients ADD COLUMN public_allowed INTEGER NOT NULL DEFAULT 1;
  `,
];

export interface OAuthClient {
  /** 动态注册时生成的随机 ID，或 CIMD 客户端的元数据文档 URL */
  id: string;
  kind: 'dcr' | 'cimd';
  name: string | null;
  uri: string | null;
  redirectUris: string[];
  /** 机密客户端 client_secret 的 SHA-256；公共客户端为 null */
  secretHash: string | null;
  /** 支持 private_key_jwt 时，验证客户端断言所用的 JWKS 地址 */
  jwksUri: string | null;
  /** 是否允许不带任何凭证（仅靠 PKCE）换取令牌 */
  publicAllowed: boolean;
  createdAt: number;
  fetchedAt: number | null;
}

/** 用户在授权页上证明自己能访问哪个账本的方式 */
export type GrantSource =
  | { kind: 'passphrase'; code: string }
  | { kind: 'session'; tokenHash: string }
  | { kind: 'ledger'; ledgerId: string; subject: string };

export interface AuthCodeInput {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
  resource: string;
}

export interface TokenInput {
  accessHash: string;
  refreshHash: string;
}

/** 签发令牌后返回给 token 端点的信息 */
export interface IssuedGrant {
  scope: string;
  accessExpiresAt: number;
}

/** 一个有效的 MCP 访问令牌所代表的权限 */
export interface AccessGrant {
  grantId: string;
  clientId: string;
  clientName: string | null;
  ledger: LedgerInfo;
  scope: string;
  resource: string;
}

type ClientRow = {
  id: string;
  kind: 'dcr' | 'cimd';
  name: string | null;
  uri: string | null;
  redirect_uris: string;
  secret_hash: string | null;
  jwks_uri: string | null;
  public_allowed: number;
  created_at: number;
  fetched_at: number | null;
};

type CodeRow = {
  client_id: string;
  ledger_id: string;
  passphrase_id: string | null;
  subject: string | null;
  redirect_uri: string;
  challenge: string;
  scope: string;
  resource: string;
  grant_expires_at: number;
  expires_at: number;
};

const toClient = (r: ClientRow): OAuthClient => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  uri: r.uri,
  redirectUris: JSON.parse(r.redirect_uris) as string[],
  secretHash: r.secret_hash,
  jwksUri: r.jwks_uri,
  publicAllowed: r.public_allowed === 1,
  createdAt: r.created_at,
  fetchedAt: r.fetched_at,
});

/** 连接列表里展示的来源：优先客户端主页，其次回调地址的主机名 */
function clientHost(uri: string | null, redirectUris: string[], id: string) {
  for (const candidate of [uri, redirectUris[0], id]) {
    const host = candidate ? URL.parse(candidate)?.host : undefined;
    if (host) return host;
  }
  return null;
}

type LedgerRow = { id: string; name: string; created_at: number; active: number; connections: number };
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
                (SELECT COUNT(*) FROM passphrases p WHERE p.ledger_id = l.id AND ${ACTIVE}) AS active,
                (SELECT COUNT(*) FROM oauth_grants g WHERE g.ledger_id = l.id AND g.expires_at > ?) AS connections
         FROM ledgers l ORDER BY l.created_at DESC`,
        now,
        now,
        now,
      )
      .map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        activePassphrases: r.active,
        connections: r.connections,
      }));
  }

  getLedger(id: string): LedgerInfo {
    const row = first(this.db.all<{ id: string; name: string }>('SELECT id, name FROM ledgers WHERE id = ?', id));
    if (!row) throw notFound('账本不存在');
    return row;
  }

  createLedger(name: string): LedgerRecord {
    this.assertLedgerNameFree(name);
    const ledger = { id: newId(), name, createdAt: Date.now(), activePassphrases: 0, connections: 0 };
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
    const p = this.activePassphrase(code, now);
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

  // ---------- OAuth（MCP 连接） ----------

  getClient(id: string): OAuthClient | null {
    const row = first(this.db.all<ClientRow>('SELECT * FROM oauth_clients WHERE id = ?', id));
    return row ? toClient(row) : null;
  }

  /** 注册或更新客户端；用 UPSERT 而非 REPLACE，避免级联删除已有授权 */
  saveClient(client: OAuthClient): void {
    const now = Date.now();
    this.db.run(
      `DELETE FROM oauth_clients WHERE kind = 'dcr' AND last_used_at < ?
       AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)`,
      now - OAUTH_TTL.idleClient,
    );
    this.db.run(
      `INSERT INTO oauth_clients (id, kind, name, uri, redirect_uris, secret_hash, jwks_uri, public_allowed,
         created_at, fetched_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, uri = excluded.uri,
         redirect_uris = excluded.redirect_uris, jwks_uri = excluded.jwks_uri,
         public_allowed = excluded.public_allowed, fetched_at = excluded.fetched_at`,
      client.id,
      client.kind,
      client.name,
      client.uri,
      JSON.stringify(client.redirectUris),
      client.secretHash,
      client.jwksUri,
      client.publicAllowed ? 1 : 0,
      client.createdAt,
      client.fetchedAt,
      now,
    );
  }

  /** 用户同意授权后签发授权码，返回被授权的账本 */
  createAuthCode(source: GrantSource, input: AuthCodeInput): LedgerInfo {
    const now = Date.now();
    const grant = this.resolveGrantSource(source, now);
    this.db.run('DELETE FROM oauth_codes WHERE expires_at <= ?', now);
    this.db.run(
      `INSERT INTO oauth_codes (code_hash, client_id, ledger_id, passphrase_id, subject, redirect_uri, challenge,
         scope, resource, grant_expires_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.codeHash,
      input.clientId,
      grant.ledger.id,
      grant.passphraseId,
      grant.subject,
      input.redirectUri,
      input.challenge,
      input.scope,
      input.resource,
      grant.expiresAt,
      now + OAUTH_TTL.code,
    );
    this.db.run('UPDATE oauth_clients SET last_used_at = ? WHERE id = ?', now, input.clientId);
    return grant.ledger;
  }

  /**
   * 兑换授权码（只能使用一次）。challenge 是调用方由 code_verifier 计算出的 S256 值；
   * redirectUri / resource 为 null 表示令牌请求未携带。任何一项不匹配都返回 null，
   * 由调用方回复 invalid_grant。
   */
  exchangeCode(
    check: { codeHash: string; clientId: string; redirectUri: string | null; challenge: string; resource: string | null },
    tokens: TokenInput,
  ): IssuedGrant | null {
    return this.db.transaction(() => {
      const now = Date.now();
      const code = first(this.db.all<CodeRow>('DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *', check.codeHash));
      if (
        !code ||
        code.expires_at <= now ||
        code.client_id !== check.clientId ||
        (check.redirectUri !== null && check.redirectUri !== code.redirect_uri) ||
        code.challenge !== check.challenge ||
        (check.resource !== null && check.resource !== code.resource)
      ) {
        return null;
      }
      const grantId = newId();
      this.db.run('DELETE FROM oauth_grants WHERE expires_at <= ?', now);
      this.db.run(
        `INSERT INTO oauth_grants (id, client_id, ledger_id, passphrase_id, subject, scope, resource, refresh_hash,
           created_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        grantId,
        code.client_id,
        code.ledger_id,
        code.passphrase_id,
        code.subject,
        code.scope,
        code.resource,
        tokens.refreshHash,
        now,
        now,
        code.grant_expires_at,
      );
      this.emit({ type: 'connections.changed', ledgerId: code.ledger_id });
      return this.insertAccessToken(grantId, tokens.accessHash, code.scope, now);
    });
  }

  /** 刷新令牌轮换：旧的刷新令牌立即作废，同时签发新的访问令牌 */
  refreshGrant(refreshHash: string, clientId: string, tokens: TokenInput): IssuedGrant | null {
    return this.db.transaction(() => {
      const now = Date.now();
      const grant = first(
        this.db.all<{ id: string; scope: string }>(
          'SELECT id, scope FROM oauth_grants WHERE refresh_hash = ? AND client_id = ? AND expires_at > ?',
          refreshHash,
          clientId,
          now,
        ),
      );
      if (!grant) return null;
      this.db.run(
        'UPDATE oauth_grants SET refresh_hash = ?, last_used_at = ? WHERE id = ?',
        tokens.refreshHash,
        now,
        grant.id,
      );
      return this.insertAccessToken(grant.id, tokens.accessHash, grant.scope, now);
    });
  }

  resolveAccessToken(tokenHash: string): AccessGrant | null {
    const now = Date.now();
    const row = first(
      this.db.all<{
        grant_id: string;
        client_id: string;
        client_name: string | null;
        ledger_id: string;
        ledger_name: string;
        scope: string;
        resource: string;
        last_used_at: number;
      }>(
        `SELECT g.id AS grant_id, g.client_id, c.name AS client_name, g.ledger_id, l.name AS ledger_name,
                g.scope, g.resource, g.last_used_at
         FROM oauth_tokens t
         JOIN oauth_grants g ON g.id = t.grant_id
         JOIN oauth_clients c ON c.id = g.client_id
         JOIN ledgers l ON l.id = g.ledger_id
         WHERE t.token_hash = ? AND t.expires_at > ? AND g.expires_at > ?`,
        tokenHash,
        now,
        now,
      ),
    );
    if (!row) return null;
    // 「最近使用」只需粗略精度，避免每次请求都写库
    if (now - row.last_used_at > 5 * 60_000) {
      this.db.run('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?', now, row.grant_id);
    }
    return {
      grantId: row.grant_id,
      clientId: row.client_id,
      clientName: row.client_name,
      ledger: { id: row.ledger_id, name: row.ledger_name },
      scope: row.scope,
      resource: row.resource,
    };
  }

  /** RFC 7009：撤销刷新令牌会结束整个授权，撤销访问令牌只作废它本身 */
  revokeToken(tokenHash: string): void {
    const grant = first(
      this.db.all<{ ledger_id: string }>('DELETE FROM oauth_grants WHERE refresh_hash = ? RETURNING ledger_id', tokenHash),
    );
    if (grant) this.emit({ type: 'connections.changed', ledgerId: grant.ledger_id });
    else this.db.run('DELETE FROM oauth_tokens WHERE token_hash = ?', tokenHash);
  }

  listConnections(ledgerId: string): Connection[] {
    return this.db
      .all<ClientRow & { grant_id: string; scope: string; grant_created_at: number; grant_last_used_at: number; expires_at: number }>(
        `SELECT c.*, g.id AS grant_id, g.scope, g.created_at AS grant_created_at,
                g.last_used_at AS grant_last_used_at, g.expires_at
         FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
         WHERE g.ledger_id = ? AND g.expires_at > ?
         ORDER BY g.last_used_at DESC`,
        ledgerId,
        Date.now(),
      )
      .map((r) => {
        const client = toClient(r);
        return {
          id: r.grant_id,
          clientName: client.name,
          clientHost: clientHost(client.uri, client.redirectUris, client.id),
          scopes: r.scope.split(' ').filter(Boolean) as McpScope[],
          createdAt: r.grant_created_at,
          lastUsedAt: r.grant_last_used_at,
          expiresAt: r.expires_at,
        };
      });
  }

  revokeConnection(id: string, ledgerId: string): void {
    if (!first(this.db.all('DELETE FROM oauth_grants WHERE id = ? AND ledger_id = ? RETURNING id', id, ledgerId))) {
      throw notFound('该连接不存在或已断开');
    }
    this.emit({ type: 'connections.changed', ledgerId });
  }

  // ---------- 内部工具 ----------

  private resolveGrantSource(source: GrantSource, now: number) {
    const cap = (validUntil: number | null) => Math.min(validUntil ?? Infinity, now + OAUTH_TTL.grant);
    switch (source.kind) {
      case 'passphrase': {
        const p = this.activePassphrase(source.code, now);
        return { ledger: { id: p.ledger_id, name: p.name }, passphraseId: p.id, subject: null, expiresAt: cap(p.valid_until) };
      }
      case 'session': {
        const row = first(
          this.db.all<{ ledger_id: string; name: string; passphrase_id: string | null; subject: string | null; valid_until: number | null }>(
            `SELECT s.ledger_id, l.name, s.passphrase_id, s.subject, p.valid_until
             FROM sessions s
             JOIN ledgers l ON l.id = s.ledger_id
             LEFT JOIN passphrases p ON p.id = s.passphrase_id
             WHERE s.token_hash = ? AND s.kind = 'ledger' AND s.expires_at > ?`,
            source.tokenHash,
            now,
          ),
        );
        if (!row) throw new AppError(401, '当前浏览器的账本登录已过期，请输入口令');
        return {
          ledger: { id: row.ledger_id, name: row.name },
          passphraseId: row.passphrase_id,
          subject: row.subject,
          expiresAt: cap(row.valid_until),
        };
      }
      case 'ledger':
        return { ledger: this.getLedger(source.ledgerId), passphraseId: null, subject: source.subject, expiresAt: cap(null) };
    }
  }

  private activePassphrase(code: string, now: number) {
    const rows = this.db.all<PassphraseRow & { name: string }>(
      `SELECT p.*, l.name FROM passphrases p JOIN ledgers l ON l.id = p.ledger_id
       WHERE p.code = ? AND (p.valid_until IS NULL OR p.valid_until > ?)
       ORDER BY p.valid_from`,
      code,
      now,
    );
    const p = rows.find((r) => r.valid_from <= now);
    if (!p) throw new AppError(401, rows.length ? '口令尚未生效' : '口令无效或已过期');
    return p;
  }

  private insertAccessToken(grantId: string, accessHash: string, scope: string, now: number): IssuedGrant {
    const accessExpiresAt = now + OAUTH_TTL.access;
    this.db.run('DELETE FROM oauth_tokens WHERE expires_at <= ?', now);
    this.db.run('INSERT INTO oauth_tokens (token_hash, grant_id, expires_at) VALUES (?, ?, ?)', accessHash, grantId, accessExpiresAt);
    return { scope, accessExpiresAt };
  }

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
