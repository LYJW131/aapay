import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver, SqlValue } from '../core/sql.ts';

export function openSqlite(path: string): SqlDriver & { close(): void } {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const prepare = (sql: string) => {
    let stmt = statements.get(sql);
    if (!stmt) statements.set(sql, (stmt = db.prepare(sql)));
    return stmt;
  };
  let depth = 0;
  return {
    all: <T>(sql: string, ...params: SqlValue[]) => prepare(sql).all(...params) as T[],
    run: (sql, ...params) => void prepare(sql).run(...params),
    exec: (sql) => db.exec(sql),
    transaction<T>(fn: () => T): T {
      // 允许嵌套调用：只有最外层真正开启事务
      if (depth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}
