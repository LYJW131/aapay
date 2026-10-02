export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/**
 * 极简的同步 SQLite 接口。Durable Object 的 SQLite 存储与 Node 内置的 node:sqlite
 * 都是同步 API，因此业务层可以在两个平台上共用同一套代码。
 */
export interface SqlDriver {
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  run(sql: string, ...params: SqlValue[]): void;
  /** 执行多条语句（用于建表迁移），不支持参数 */
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

export function first<T>(rows: T[]): T | undefined {
  return rows[0];
}

/** 基于 user_version 的顺序迁移 */
export function migrate(db: SqlDriver, migrations: readonly string[]) {
  db.exec('CREATE TABLE IF NOT EXISTS _schema (version INTEGER NOT NULL)');
  const row = first(db.all<{ version: number }>('SELECT version FROM _schema'));
  const current = row?.version ?? 0;
  if (current >= migrations.length) return;
  db.transaction(() => {
    for (const sql of migrations.slice(current)) db.exec(sql);
    if (row) db.run('UPDATE _schema SET version = ?', migrations.length);
    else db.run('INSERT INTO _schema (version) VALUES (?)', migrations.length);
  });
}
