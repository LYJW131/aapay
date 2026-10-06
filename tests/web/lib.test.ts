import { beforeAll, describe, expect, it, vi } from 'vitest';
import { inCategory } from '../../src/web/features/ledger/filters.ts';
import { toCsv } from '../../src/web/lib/csv.ts';
import type { Expense, Settlement } from '../../src/shared/types.ts';

let sse: typeof import('../../src/web/lib/sse.ts');

beforeAll(async () => {
  vi.stubGlobal('document', { documentElement: {} });
  sse = await import('../../src/web/lib/sse.ts');
});

describe('toCsv', () => {
  it('quotes every cell, escapes quotes and defuses formulas', () => {
    expect(toCsv([['用途', '金额'], ['say "hi"', 12.5], ['=SUM(A1)', -3], ['+1', '@x'], ['-2', '\tTab']])).toBe(
      ['"用途","金额"', '"say ""hi""","12.5"', `"'=SUM(A1)","-3"`, `"'+1","'@x"`, `"'-2","'\tTab"`].join('\r\n'),
    );
  });
});

describe('inCategory', () => {
  const expense = (category: Expense['category']) => ({ id: 'e', title: 't', amount: 1, payerId: 'p', date: '2026-10-01', category, shares: [], createdAt: 0, updatedAt: 0 }) as unknown as Expense;
  const settlement = { id: 's', fromId: 'a', toId: 'b', amount: 1, date: '2026-10-01', note: null, createdAt: 0 } as Settlement;

  it('separates uncategorized from all and never matches settlements', () => {
    expect(inCategory(expense(null), null)).toBe(true);
    expect(inCategory(settlement, null)).toBe(true);
    expect(inCategory(expense(null), 'none')).toBe(true);
    expect(inCategory(expense('food'), 'none')).toBe(false);
    expect(inCategory(expense('food'), 'food')).toBe(true);
    expect(inCategory(expense('food'), 'transport')).toBe(false);
    expect(inCategory(settlement, 'none')).toBe(false);
    expect(inCategory(settlement, 'food')).toBe(false);
  });
});

describe('parseSse', () => {
  const collect = (chunks: string[], end = true) => {
    const out: { event: string; data: string }[] = [];
    const parser = sse.parseSse((m) => out.push(m));
    for (const c of chunks) parser.push(c);
    if (end) parser.end();
    return out;
  };

  it('handles CRLF split across chunks, comments and multi-line data', () => {
    const raw = ': ping\r\nevent: text\r\ndata: a\r\ndata: b\r\n\r\ndata: plain\n\nevent: done\rdata: {}\r\r';
    const expected = [
      { event: 'text', data: 'a\nb' },
      { event: 'message', data: 'plain' },
      { event: 'done', data: '{}' },
    ];
    for (let i = 0; i <= raw.length; i++) expect(collect([raw.slice(0, i), raw.slice(i)])).toEqual(expected);
  });

  it('flushes a trailing event without a blank line only at the end', () => {
    expect(collect(['event: done\ndata: {}'], false)).toEqual([]);
    expect(collect(['event: done\ndata: {}\r'])).toEqual([{ event: 'done', data: '{}' }]);
  });

  it('turns a dropped connection into a network error', async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulls++ === 0) c.enqueue(new TextEncoder().encode('data: x\n\n'));
        else c.error(new TypeError('network error'));
      },
    });
    vi.stubGlobal('fetch', async () => new Response(body));
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const m of sse.streamSse('/x', {})) seen.push(m.data);
      })(),
    ).rejects.toMatchObject({ name: 'ApiError', status: 0 });
    expect(seen).toEqual(['x']);
    vi.unstubAllGlobals();
    vi.stubGlobal('document', { documentElement: {} });
  });
});
