import type { Database } from 'sql.js';
import type { Row, SqlDriver, SqlValue } from '../server/core/sql.ts';

export function sqlDriver(db: Database): SqlDriver {
  db.exec('PRAGMA foreign_keys = ON');
  let depth = 0;
  return {
    all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        const rows: T[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject() as T);
        return rows;
      } finally {
        stmt.free();
      }
    },
    run: (sql, ...params) => void db.run(sql, params),
    exec: (sql) => void db.exec(sql),
    transaction<T>(fn: () => T): T {
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
  };
}

// sql.js 导出时会关闭再重开数据库，连接级的 PRAGMA 随之失效
export function exportDb(db: Database) {
  const bytes = db.export();
  db.exec('PRAGMA foreign_keys = ON');
  return bytes;
}
