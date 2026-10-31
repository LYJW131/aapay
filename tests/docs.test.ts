import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

// 按字节量限：开场整段进上下文的是字节，不是行数
const ROOT_AGENTS_MAX_BYTES = 16_000;
const NESTED_AGENTS_MAX_BYTES = 12_000;
const CODE_EXTENSIONS = /\.(ts|tsx|mjs|js|json|jsonc|css|yml|yaml|md|svg|png|toml)$/;
const TIMELINE = /已改为|改成了|原先|此前|以前是|\d{1,2}-\d{1,2}\s*起/;

const root = join(import.meta.dirname, '..');
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && existsSync(join(root, f)));
const tracked = new Set(files);
const dirs = new Set(files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
const basenames = new Set(files.map((f) => basename(f)));
const docs = files.filter((f) => f.endsWith('.md') && !f.startsWith('node_modules/'));

const exists = (path: string) => tracked.has(path) || dirs.has(path.replace(/\/$/, ''));

function lines(text: string) {
  let fenced = false;
  return text.split('\n').flatMap((line, i) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return [];
    }
    return fenced ? [] : [{ n: i + 1, line }];
  });
}

function problems(doc: string) {
  const text = readFileSync(join(root, doc), 'utf8');
  const dir = posix.dirname(doc);
  const issues: string[] = [];
  for (const { n, line } of lines(text)) {
    const at = `${doc}:${n}`;
    for (const [, target] of line.matchAll(/(?:\]\(|src="|srcset=")([^)"\s]+)/g)) {
      if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
      const path = posix.normalize(posix.join(dir, target.split('#')[0]!));
      if (!exists(path)) issues.push(`${at} 链接指向不存在的 ${target}`);
    }
    for (const [, span] of line.matchAll(/`([^`\s]+)`/g)) {
      if (!span || /[<>*${}@]|^https?:|^\/|^\.\.?\/?$/.test(span)) continue;
      const [path = '', symbol] = span.split('#');
      if (path.includes('/') && !CODE_EXTENSIONS.test(path) && !/\.\w+$/.test(path) && !path.endsWith('/')) continue;
      if (!path.includes('/')) {
        if (CODE_EXTENSIONS.test(path) && !basenames.has(path)) issues.push(`${at} 找不到文件 ${span}`);
        continue;
      }
      const first = path.split('/')[0]!;
      const candidates = [path, posix.join(dir, path)].map((p) => p.replace(/\/$/, ''));
      const found = candidates.find(exists);
      if (!found) {
        if (dirs.has(first) || dirs.has(posix.join(dir, first)) || tracked.has(first)) issues.push(`${at} 路径不存在 ${span}`);
        continue;
      }
      if (symbol && tracked.has(found) && !new RegExp(`\\b${symbol.replace(/\W/g, '\\$&')}\\b`).test(readFileSync(join(root, found), 'utf8'))) {
        issues.push(`${at} ${found} 里没有 ${symbol}`);
      }
    }
  }
  return issues;
}

describe('文档', () => {
  it('链接、反引号路径与路径#符号都存在', () => {
    expect(docs.flatMap(problems)).toEqual([]);
  });

  it('CLAUDE.md 只引用同目录的 AGENTS.md', () => {
    for (const file of files.filter((f) => basename(f) === 'CLAUDE.md')) {
      expect(readFileSync(join(root, file), 'utf8'), file).toBe('@AGENTS.md\n');
      expect(existsSync(join(root, dirname(file), 'AGENTS.md')), file).toBe(true);
    }
  });

  it('AGENTS.md 不超过字节上限', () => {
    for (const file of files.filter((f) => basename(f) === 'AGENTS.md')) {
      const limit = file === 'AGENTS.md' ? ROOT_AGENTS_MAX_BYTES : NESTED_AGENTS_MAX_BYTES;
      expect(readFileSync(join(root, file)).byteLength, file).toBeLessThanOrEqual(limit);
    }
  });

  it('面向 agent 的文档只写现状，不写时间线', () => {
    const hits = files
      .filter((f) => /(^|\/)(AGENTS|HUMAN)\.md$/.test(f))
      .flatMap((f) => lines(readFileSync(join(root, f), 'utf8')).flatMap(({ n, line }) => (TIMELINE.test(line) ? [`${f}:${n} ${line.trim()}`] : [])));
    expect(hits).toEqual([]);
  });
});
