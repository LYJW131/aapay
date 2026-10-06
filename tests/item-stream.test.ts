import { describe, expect, it } from 'vitest';
import { ItemStream } from '../src/server/ai/item-stream.ts';

const doc = '```json\n{"items":[{"title":"a}\\"b,{","amount":18.5,"date":"2026-10-01"},{"title":"咖啡😀","amount":3,"date":null}]}\n```';
const expected = [
  { title: 'a}"b,{', amount: 18.5, date: '2026-10-01' },
  { title: '咖啡😀', amount: 3, date: null },
];

const run = (chunks: string[], depth = 3) => {
  const stream = new ItemStream(depth);
  return chunks.flatMap((c) => stream.feed(c));
};
const done = (events: ReturnType<typeof run>) => events.filter((e) => e.done).map((e) => e.value);

describe('ItemStream', () => {
  it('parses the whole text at once', () => {
    expect(done(run([doc]))).toEqual(expected);
  });

  it('parses character by character, across escapes and surrogate pairs', () => {
    expect(done(run([...doc]))).toEqual(expected);
  });

  it('parses every two-way split', () => {
    for (let i = 0; i <= doc.length; i++) expect(done(run([doc.slice(0, i), doc.slice(i)]))).toEqual(expected);
  });

  it('supports a bare array root', () => {
    expect(done(run(['[{"a":1},{"a":2}]'], 2))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('reports a malformed item and keeps parsing later ones', () => {
    const events = run(['{"items":[{"a":1,},{"a":2}]}']);
    expect(events[0]).toMatchObject({ index: 0, done: true, value: null });
    expect(events[1]).toMatchObject({ index: 1, done: true, value: { a: 2 } });
  });

  it('keeps nested values inside an item', () => {
    expect(done(run(['{"items":[{"p":[1,{"x":2}],"q":{"r":"]"}}]}']))).toEqual([{ p: [1, { x: 2 }], q: { r: ']' } }]);
  });

  it('emits growing partial fields but never half a number', () => {
    const partials = run([...'{"items":[{"title":"瑞幸","amount":18.5,"date":"2026"}]}'])
      .filter((e) => !e.done)
      .map((e) => JSON.stringify(e.value));
    expect(partials).toContain('{"title":"瑞"}');
    expect(partials).toContain('{"title":"瑞幸"}');
    expect(partials).toContain('{"title":"瑞幸","amount":18.5}');
    expect(partials).toContain('{"title":"瑞幸","amount":18.5,"date":"20"}');
    expect(partials).not.toContain('{"title":"瑞幸","amount":18}');
    expect(partials).not.toContain('{"title":"瑞幸","amount":1}');
    expect(new Set(partials).size).toBe(partials.length);
  });

  it('emits no phantom item for a truncated stream', () => {
    expect(done(run(['{"items":[{"a":1},{"a":']))).toEqual([{ a: 1 }]);
  });
});
