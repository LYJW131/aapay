import type { AuditActor } from '../../shared/audit.ts';
import { LEDGER_EMOJIS } from '../../shared/emoji.ts';
import type { LedgerInput, PassphraseInput } from '../../shared/schema.ts';
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
import { newId } from '../../shared/ids.ts';
import { first, migrate, type SqlDriver, type SqlValue } from './sql.ts';

const DAY = 86_400_000;
export const SESSION_TTL = {
  member: 180 * DAY,
  console: DAY,
} as const;

const CONSOLE_BOUND = "(s.role <> 'admin' OR EXISTS (SELECT 1 FROM sessions c WHERE c.token_hash = s.console_hash AND c.kind = 'console'))";

export const OAUTH_TTL = {
  code: 5 * 60_000,
  access: 60 * 60_000,
  grant: 180 * DAY,
  adminGrant: 30 * DAY,
  idleClient: 30 * DAY,
  metadata: DAY,
} as const;

export const MIGRATIONS = [
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
  ALTER TABLE oauth_clients ADD COLUMN jwks_uri TEXT;
  ALTER TABLE oauth_clients ADD COLUMN public_allowed INTEGER NOT NULL DEFAULT 1;
  `,
  `
  -- 管理员授权不绑定账本；重建表时保留已有的成员授权与令牌
  CREATE TABLE oauth_grants_v2 (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
    ledger_id TEXT REFERENCES ledgers (id) ON DELETE CASCADE,
    passphrase_id TEXT REFERENCES passphrases (id) ON DELETE CASCADE,
    subject TEXT,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    refresh_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    CHECK ((role = 'admin') = (ledger_id IS NULL))
  );
  INSERT INTO oauth_grants_v2 (id, client_id, role, ledger_id, passphrase_id, subject, scope, resource, refresh_hash,
      created_at, last_used_at, expires_at)
    SELECT id, client_id, 'member', ledger_id, passphrase_id, subject, scope, resource, refresh_hash,
      created_at, last_used_at, expires_at
    FROM oauth_grants;

  CREATE TABLE oauth_tokens_v2 (
    token_hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES oauth_grants_v2 (id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  INSERT INTO oauth_tokens_v2 (token_hash, grant_id, expires_at) SELECT token_hash, grant_id, expires_at FROM oauth_tokens;

  DROP TABLE oauth_tokens;
  DROP TABLE oauth_grants;
  DROP TABLE oauth_codes;
  -- 重命名时，oauth_tokens 中指向 oauth_grants_v2 的外键会自动改写为 oauth_grants
  ALTER TABLE oauth_grants_v2 RENAME TO oauth_grants;
  ALTER TABLE oauth_tokens_v2 RENAME TO oauth_tokens;
  CREATE INDEX oauth_grants_ledger ON oauth_grants (ledger_id);
  CREATE INDEX oauth_grants_client ON oauth_grants (client_id);
  CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);
  CREATE INDEX oauth_tokens_expires ON oauth_tokens (expires_at);

  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
    ledger_id TEXT REFERENCES ledgers (id) ON DELETE CASCADE,
    passphrase_id TEXT REFERENCES passphrases (id) ON DELETE CASCADE,
    subject TEXT,
    redirect_uri TEXT NOT NULL,
    challenge TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    grant_expires_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  `ALTER TABLE ledgers ADD COLUMN emoji TEXT NOT NULL DEFAULT '📒';`,
  `
  -- 管理员进入账本的会话随签发它的管理员会话一起失效；迁移前留下的这类会话没有绑定，会直接失效
  ALTER TABLE sessions ADD COLUMN console_hash TEXT;
  CREATE INDEX sessions_console ON sessions (console_hash);
  `,
];

export type GrantRole = 'member' | 'admin';

export interface OAuthClient {
  id: string;
  kind: 'dcr' | 'cimd';
  name: string | null;
  uri: string | null;
  redirectUris: string[];
  secretHash: string | null;
  jwksUri: string | null;
  publicAllowed: boolean;
  createdAt: number;
  fetchedAt: number | null;
}

export type GrantSource =
  | { kind: 'passphrase'; code: string }
  | { kind: 'session'; tokenHash: string }
  | { kind: 'ledger'; ledgerId: string; subject: string }
  | { kind: 'admin'; subject: string };

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

export interface IssuedGrant {
  scope: string;
  accessExpiresAt: number;
}

export interface ConnectionInfo {
  client: string | null;
  host: string | null;
  verified: boolean;
}

export interface NewConnection extends ConnectionInfo {
  ledgerId: string;
  authorizer: AuditActor;
  scopes: string[];
}

export interface AccessGrant {
  grantId: string;
  clientId: string;
  clientName: string | null;
  clientHost: string | null;
  // CIMD 客户端的名称来自其域名上托管的元数据，动态注册的名称是自报的
  clientVerified: boolean;
  role: GrantRole;
  ledger: LedgerInfo | null;
  subject: string | null;
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
  role: GrantRole;
  ledger_id: string | null;
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

function clientHost(uri: string | null, redirectUris: string[], id: string) {
  for (const candidate of [uri, redirectUris[0], id]) {
    const host = candidate ? URL.parse(candidate)?.host : undefined;
    if (host) return host;
  }
  return null;
}

type LedgerRow = { id: string; name: string; emoji: string; created_at: number; active: number; connections: number };
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

export class RegistryService {
  constructor(
    private readonly db: SqlDriver,
    private readonly emit: (event: RegistryEvent) => void,
  ) {
    migrate(db, MIGRATIONS);
  }

  listLedgers(): LedgerRecord[] {
    const now = Date.now();
    return this.db
      .all<LedgerRow>(
        `SELECT l.id, l.name, l.emoji, l.created_at,
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
        emoji: r.emoji,
        createdAt: r.created_at,
        activePassphrases: r.active,
        connections: r.connections,
      }));
  }

  getLedger(id: string): LedgerInfo {
    const row = first(this.db.all<LedgerInfo>('SELECT id, name, emoji FROM ledgers WHERE id = ?', id));
    if (!row) throw notFound('ledgerNotFound');
    return row;
  }

  createLedger({ name, emoji }: LedgerInput): LedgerRecord {
    this.assertLedgerNameFree(name);
    const ledger = {
      id: newId(),
      name,
      emoji: emoji || LEDGER_EMOJIS[Math.floor(Math.random() * LEDGER_EMOJIS.length)]!,
      createdAt: Date.now(),
      activePassphrases: 0,
      connections: 0,
    };
    this.db.run('INSERT INTO ledgers (id, name, emoji, created_at) VALUES (?, ?, ?, ?)', ledger.id, name, ledger.emoji, ledger.createdAt);
    this.emit({ type: 'ledgers.changed' });
    return ledger;
  }

  ensureLedger(id: string, name: string): LedgerInfo {
    this.db.run('INSERT OR IGNORE INTO ledgers (id, name, created_at) VALUES (?, ?, ?)', id, name, Date.now());
    return this.getLedger(id);
  }

  updateLedger(id: string, { name, emoji }: LedgerInput): LedgerInfo {
    const current = this.getLedger(id);
    this.assertLedgerNameFree(name, id);
    const ledger = { id, name, emoji: emoji || current.emoji };
    this.db.run('UPDATE ledgers SET name = ?, emoji = ? WHERE id = ?', ledger.name, ledger.emoji, id);
    this.emit({ type: 'ledgers.changed' });
    return ledger;
  }

  deleteLedger(id: string): LedgerInfo {
    const ledger = this.getLedger(id);
    this.db.run('DELETE FROM ledgers WHERE id = ?', id);
    this.emit({ type: 'ledgers.changed' });
    return ledger;
  }

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
        throw conflict('passphraseInUse');
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

  // 通过外键级联，用该口令登录的会话与 AI 授权也会立即失效
  revokePassphrase(id: string): Passphrase {
    const row = first(this.db.all<PassphraseRow>('DELETE FROM passphrases WHERE id = ? RETURNING *', id));
    if (!row) throw notFound('passphraseNotFound');
    this.emit({ type: 'passphrases.changed', ledgerId: row.ledger_id });
    return toPassphrase(row);
  }

  join(code: string, tokenHash: string): SessionInfo {
    const now = Date.now();
    const p = this.activePassphrase(code, now);
    const expiresAt = Math.min(p.valid_until ?? Infinity, now + SESSION_TTL.member);
    this.insertSession(tokenHash, 'ledger', 'member', p.ledger_id, p.id, null, null, expiresAt);
    return { ledger: { id: p.ledger_id, name: p.name, emoji: p.emoji }, role: 'member', passphrase: p.code, subject: null, expiresAt };
  }

  openLedgerSession(tokenHash: string, ledgerId: string, consoleHash: string): SessionInfo {
    const ledger = this.getLedger(ledgerId);
    const admin = this.resolveConsoleSession(consoleHash);
    if (!admin) throw new AppError(401, 'adminSessionExpired');
    this.insertSession(tokenHash, 'ledger', 'admin', ledgerId, null, admin.subject, consoleHash, admin.expiresAt);
    return { ledger, role: 'admin', passphrase: null, subject: admin.subject, expiresAt: admin.expiresAt };
  }

  openConsoleSession(tokenHash: string, subject: string): number {
    const expiresAt = Date.now() + SESSION_TTL.console;
    this.insertSession(tokenHash, 'console', 'console', null, null, subject, null, expiresAt);
    return expiresAt;
  }

  resolveLedgerSession(tokenHash: string): SessionInfo | null {
    const row = first(
      this.db.all<{ role: SessionRole; ledger_id: string; name: string; emoji: string; code: string | null; subject: string | null; expires_at: number }>(
        `SELECT s.role, s.ledger_id, l.name, l.emoji, p.code, s.subject, s.expires_at
         FROM sessions s
         JOIN ledgers l ON l.id = s.ledger_id
         LEFT JOIN passphrases p ON p.id = s.passphrase_id
         WHERE s.token_hash = ? AND s.kind = 'ledger' AND s.expires_at > ? AND ${CONSOLE_BOUND}`,
        tokenHash,
        Date.now(),
      ),
    );
    if (!row) return null;
    return {
      ledger: { id: row.ledger_id, name: row.name, emoji: row.emoji },
      role: row.role,
      passphrase: row.code,
      subject: row.subject,
      expiresAt: row.expires_at,
    };
  }

  resolveConsoleSession(tokenHash: string): { subject: string; expiresAt: number } | null {
    const row = first(
      this.db.all<{ subject: string; expires_at: number }>(
        "SELECT subject, expires_at FROM sessions WHERE token_hash = ? AND kind = 'console' AND expires_at > ?",
        tokenHash,
        Date.now(),
      ),
    );
    return row ? { subject: row.subject, expiresAt: row.expires_at } : null;
  }

  endSession(tokenHash: string): void {
    this.db.run('DELETE FROM sessions WHERE token_hash = ? OR console_hash = ?', tokenHash, tokenHash);
  }

  getClient(id: string): OAuthClient | null {
    const row = first(this.db.all<ClientRow>('SELECT * FROM oauth_clients WHERE id = ?', id));
    return row ? toClient(row) : null;
  }

  // 用 UPSERT 而非 REPLACE：REPLACE 会先删除行，级联删除已有授权
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

  createAuthCode(source: GrantSource, input: AuthCodeInput): LedgerInfo | null {
    const now = Date.now();
    const grant = this.resolveGrantSource(source, now);
    this.db.run('DELETE FROM oauth_codes WHERE expires_at <= ?', now);
    this.db.run(
      `INSERT INTO oauth_codes (code_hash, client_id, role, ledger_id, passphrase_id, subject, redirect_uri, challenge,
         scope, resource, grant_expires_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.codeHash,
      input.clientId,
      grant.role,
      grant.ledger?.id ?? null,
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

  // redirectUri / resource 为 null 表示令牌请求未携带，此时不校验该项
  exchangeCode(
    check: { codeHash: string; clientId: string; redirectUri: string | null; challenge: string; resource: string | null },
    tokens: TokenInput,
  ): (IssuedGrant & { connection: NewConnection | null }) | null {
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
        `INSERT INTO oauth_grants (id, client_id, role, ledger_id, passphrase_id, subject, scope, resource, refresh_hash,
           created_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        grantId,
        code.client_id,
        code.role,
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
      const connection: NewConnection | null =
        code.role === 'member' && code.ledger_id
          ? {
              ledgerId: code.ledger_id,
              authorizer: this.authorizer(code.passphrase_id, code.subject),
              scopes: code.scope.split(' '),
              ...this.clientInfo(code.client_id),
            }
          : null;
      return { ...this.insertAccessToken(grantId, tokens.accessHash, code.scope, now), connection };
    });
  }

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
        client_kind: 'dcr' | 'cimd';
        client_uri: string | null;
        redirect_uris: string;
        role: GrantRole;
        ledger_id: string | null;
        ledger_name: string | null;
        ledger_emoji: string | null;
        subject: string | null;
        scope: string;
        resource: string;
        last_used_at: number;
      }>(
        `SELECT g.id AS grant_id, g.client_id, c.name AS client_name, c.kind AS client_kind, c.uri AS client_uri, c.redirect_uris,
                g.role, g.ledger_id, l.name AS ledger_name, l.emoji AS ledger_emoji,
                g.subject, g.scope, g.resource, g.last_used_at
         FROM oauth_tokens t
         JOIN oauth_grants g ON g.id = t.grant_id
         JOIN oauth_clients c ON c.id = g.client_id
         LEFT JOIN ledgers l ON l.id = g.ledger_id
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
      clientHost: clientHost(row.client_uri, JSON.parse(row.redirect_uris) as string[], row.client_id),
      clientVerified: row.client_kind === 'cimd',
      role: row.role,
      ledger: row.ledger_id ? { id: row.ledger_id, name: row.ledger_name!, emoji: row.ledger_emoji! } : null,
      subject: row.role === 'admin' ? row.subject : null,
      scope: row.scope,
      resource: row.resource,
    };
  }

  // RFC 7009：撤销刷新令牌结束整个授权，撤销访问令牌只作废它本身
  revokeToken(tokenHash: string): (ConnectionInfo & { ledgerId: string }) | null {
    const grant = first(
      this.db.all<{ ledger_id: string | null; client_id: string }>(
        'DELETE FROM oauth_grants WHERE refresh_hash = ? RETURNING ledger_id, client_id',
        tokenHash,
      ),
    );
    if (!grant) {
      this.db.run('DELETE FROM oauth_tokens WHERE token_hash = ?', tokenHash);
      return null;
    }
    this.emit({ type: 'connections.changed', ledgerId: grant.ledger_id });
    return grant.ledger_id ? { ledgerId: grant.ledger_id, ...this.clientInfo(grant.client_id) } : null;
  }

  listConnections(ledgerId: string): Connection[] {
    return this.connections('g.ledger_id = ?', ledgerId);
  }

  revokeConnection(id: string, ledgerId: string): ConnectionInfo {
    const grant = first(
      this.db.all<{ client_id: string }>('DELETE FROM oauth_grants WHERE id = ? AND ledger_id = ? RETURNING client_id', id, ledgerId),
    );
    if (!grant) throw notFound('connectionNotFound');
    this.emit({ type: 'connections.changed', ledgerId });
    return this.clientInfo(grant.client_id);
  }

  listAdminConnections(): Connection[] {
    return this.connections("g.role = 'admin'");
  }

  revokeAdminConnection(id: string): void {
    if (!first(this.db.all("DELETE FROM oauth_grants WHERE id = ? AND role = 'admin' RETURNING id", id))) {
      throw notFound('connectionNotFound');
    }
    this.emit({ type: 'connections.changed', ledgerId: null });
  }

  private clientInfo(clientId: string): ConnectionInfo {
    const client = this.getClient(clientId);
    return {
      client: client?.name ?? null,
      host: client ? clientHost(client.uri, client.redirectUris, client.id) : null,
      verified: client?.kind === 'cimd',
    };
  }

  private authorizer(passphraseId: string | null, subject: string | null): AuditActor {
    if (passphraseId) {
      const row = first(this.db.all<{ code: string }>('SELECT code FROM passphrases WHERE id = ?', passphraseId));
      return { kind: 'member', passphrase: row?.code ?? null };
    }
    if (subject === 'shared') return { kind: 'shared' };
    return { kind: 'admin', name: subject ?? 'admin' };
  }

  private connections(where: string, ...params: SqlValue[]): Connection[] {
    return this.db
      .all<ClientRow & { grant_id: string; subject: string | null; scope: string; grant_created_at: number; grant_last_used_at: number; expires_at: number }>(
        `SELECT c.*, g.id AS grant_id, g.subject, g.scope, g.created_at AS grant_created_at,
                g.last_used_at AS grant_last_used_at, g.expires_at
         FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
         WHERE ${where} AND g.expires_at > ?
         ORDER BY g.last_used_at DESC`,
        ...params,
        Date.now(),
      )
      .map((r) => {
        const client = toClient(r);
        return {
          id: r.grant_id,
          clientName: client.name,
          clientHost: clientHost(client.uri, client.redirectUris, client.id),
          subject: r.subject,
          scopes: r.scope.split(' ').filter(Boolean) as McpScope[],
          createdAt: r.grant_created_at,
          lastUsedAt: r.grant_last_used_at,
          expiresAt: r.expires_at,
        };
      });
  }

  private resolveGrantSource(
    source: GrantSource,
    now: number,
  ): { role: GrantRole; ledger: LedgerInfo | null; passphraseId: string | null; subject: string | null; expiresAt: number } {
    const cap = (validUntil: number | null) => Math.min(validUntil ?? Infinity, now + OAUTH_TTL.grant);
    switch (source.kind) {
      case 'admin':
        return { role: 'admin', ledger: null, passphraseId: null, subject: source.subject, expiresAt: now + OAUTH_TTL.adminGrant };
      case 'passphrase': {
        const p = this.activePassphrase(source.code, now);
        return { role: 'member', ledger: { id: p.ledger_id, name: p.name, emoji: p.emoji }, passphraseId: p.id, subject: null, expiresAt: cap(p.valid_until) };
      }
      case 'session': {
        const row = first(
          this.db.all<{ ledger_id: string; name: string; emoji: string; passphrase_id: string | null; subject: string | null; valid_until: number | null }>(
            `SELECT s.ledger_id, l.name, l.emoji, s.passphrase_id, s.subject, p.valid_until
             FROM sessions s
             JOIN ledgers l ON l.id = s.ledger_id
             LEFT JOIN passphrases p ON p.id = s.passphrase_id
             WHERE s.token_hash = ? AND s.kind = 'ledger' AND s.expires_at > ? AND ${CONSOLE_BOUND}`,
            source.tokenHash,
            now,
          ),
        );
        if (!row) throw new AppError(401, 'ledgerSessionExpired');
        return {
          role: 'member',
          ledger: { id: row.ledger_id, name: row.name, emoji: row.emoji },
          passphraseId: row.passphrase_id,
          subject: row.subject,
          expiresAt: cap(row.valid_until),
        };
      }
      case 'ledger':
        return { role: 'member', ledger: this.getLedger(source.ledgerId), passphraseId: null, subject: source.subject, expiresAt: cap(null) };
    }
  }

  private activePassphrase(code: string, now: number) {
    const rows = this.db.all<PassphraseRow & { name: string; emoji: string }>(
      `SELECT p.*, l.name, l.emoji FROM passphrases p JOIN ledgers l ON l.id = p.ledger_id
       WHERE p.code = ? AND (p.valid_until IS NULL OR p.valid_until > ?)
       ORDER BY p.valid_from`,
      code,
      now,
    );
    const p = rows.find((r) => r.valid_from <= now);
    if (!p) throw new AppError(401, rows.length ? 'passphraseNotYetValid' : 'passphraseInvalid');
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
    consoleHash: string | null,
    expiresAt: number,
  ) {
    const now = Date.now();
    this.db.run('DELETE FROM sessions WHERE expires_at <= ?', now);
    this.db.run(
      `INSERT INTO sessions (token_hash, kind, role, ledger_id, passphrase_id, subject, console_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      tokenHash,
      kind,
      role,
      ledgerId,
      passphraseId,
      subject,
      consoleHash,
      expiresAt,
      now,
    );
  }

  private assertLedgerNameFree(name: string, exceptId = '') {
    if (first(this.db.all('SELECT 1 FROM ledgers WHERE name = ? AND id != ?', name, exceptId))) {
      throw conflict('ledgerExists', { name });
    }
  }
}
