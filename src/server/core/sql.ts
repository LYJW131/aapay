export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface SqlDriver {
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  run(sql: string, ...params: SqlValue[]): void;
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

export function first<T>(rows: T[]): T | undefined {
  return rows[0];
}

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
