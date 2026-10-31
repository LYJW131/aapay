import type { Locale } from '../shared/i18n.ts';
import { newId } from '../shared/ids.ts';

export type Call = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ id?: string }>;
export type DemoLedgers = Record<Locale, string>;

const pad = (n: number) => String(n).padStart(2, '0');

function day(offset: number, now: number) {
  const d = new Date(now + 8 * 3600_000);
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const TEXT: Record<Locale, { code: string; trip: string; flat: string; flatCode: string; people: string[]; titles: string[]; note: string }> = {
  'zh-CN': {
    code: 'demo2026',
    flatCode: 'room302',
    trip: '国庆出游',
    flat: '合租 302',
    people: ['阿杰', '小雨', '老王', 'Mia'],
    titles: ['高铁票', '火锅', '民宿', '早餐', '景区门票', '午饭', '打车', '奶茶', '烧烤', '超市', '早餐', '咖啡'],
    note: '微信转账',
  },
  en: {
    code: 'demoen26',
    flatCode: 'flat302',
    trip: 'Golden Week trip',
    flat: 'Flat 302',
    people: ['Jay', 'Yuki', 'Wang', 'Mia'],
    titles: ['Train tickets', 'Hot pot', 'Guesthouse', 'Breakfast', 'Park tickets', 'Lunch', 'Taxi', 'Bubble tea', 'Barbecue', 'Groceries', 'Breakfast', 'Coffee'],
    note: 'Bank transfer',
  },
};

export const DEMO_CODES = Object.fromEntries(Object.entries(TEXT).map(([locale, text]) => [locale, text.code])) as Record<Locale, string>;

export async function seedDemo(call: Call, now = Date.now()): Promise<DemoLedgers> {
  await call('GET', '/admin/login');
  const ledgers = {} as DemoLedgers;
  for (const locale of Object.keys(TEXT) as Locale[]) ledgers[locale] = await seedLedgers(call, TEXT[locale], now);
  return ledgers;
}

async function seedLedgers(call: Call, text: (typeof TEXT)[Locale], now: number) {
  const [jay, yuki, wang, mia] = text.people as [string, string, string, string];
  const ledger = await call('POST', '/admin/ledgers', { name: text.trip });
  await call('POST', `/admin/ledgers/${ledger.id}/passphrases`, { code: text.code, validUntil: null });
  await call('POST', '/join', { code: text.code });

  const apply = (changes: unknown[]) => call('POST', '/ledger/changes', { changes });

  const people: Record<string, string> = {};
  const members = (
    [
      [jay, '🦊'],
      [yuki, '🐼'],
      [wang, '🐯'],
      [mia, '🐱'],
    ] as const
  ).map(([name, avatar]) => {
    people[name] = newId();
    return { op: 'member.create', id: people[name], member: { name, avatar } };
  });
  await apply(members);
  const all = Object.values(people);
  const even = (...names: string[]) => ({ mode: 'even', memberIds: names.length ? names.map((n) => people[n]) : all });
  const exact = (shares: Record<string, number>) => ({
    mode: 'exact',
    shares: Object.entries(shares).map(([n, amount]) => ({ memberId: people[n], amount })),
  });

  const expenses: [number, number, string, string, unknown][] = [
    [-4, 123600, jay, 'transport', even()],
    [-4, 46800, yuki, 'food', even()],
    [-3, 158000, wang, 'lodging', exact({ [jay]: 39500, [yuki]: 39500, [wang]: 52000, [mia]: 27000 })],
    [-3, 8600, mia, 'food', even()],
    [-3, 52000, jay, 'fun', even()],
    [-2, 31200, yuki, 'food', even(jay, yuki, wang)],
    [-2, 5800, mia, 'transport', even(mia, yuki)],
    [-2, 6400, wang, 'food', even()],
    [-1, 42600, jay, 'food', exact({ [jay]: 12600, [yuki]: 9000, [wang]: 12000, [mia]: 9000 })],
    [-1, 19850, mia, 'groceries', even()],
    [0, 7200, wang, 'food', even()],
    [0, 9600, yuki, 'food', even(yuki, mia, jay)],
  ];
  await apply(
    expenses.map(([offset, amount, payer, category, split], i) => ({
      op: 'expense.create',
      id: newId(),
      expense: { title: text.titles[i], amount, payerId: people[payer], date: day(offset, now), category, split },
    })),
  );
  await apply([
    {
      op: 'settlement.create',
      id: newId(),
      settlement: { fromId: people[mia], toId: people[jay], amount: 30000, date: day(-1, now), note: text.note },
    },
  ]);

  const flat = await call('POST', '/admin/ledgers', { name: text.flat });
  await call('POST', `/admin/ledgers/${flat.id}/passphrases`, { code: text.flatCode, validUntil: now + 30 * 86400_000 });
  return ledger.id!;
}
