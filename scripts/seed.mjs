const base = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
const cookies = new Map();
const accessHeaders = process.env.CF_ACCESS_CLIENT_ID
  ? { 'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET }
  : {};

async function call(method, path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      ...(path.startsWith('/admin') ? accessHeaders : {}),
    },
    body: body && JSON.stringify(body),
    redirect: 'manual',
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => {
  const d = new Date(Date.now() + 8 * 3600_000); // 按北京时间计算日期
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

const ledger = await call('POST', '/admin/ledgers', { name: '国庆出游' });
await call('POST', `/admin/ledgers/${ledger.id}/passphrases`, { code: 'demo2026', validUntil: null });
await call('POST', '/join', { code: 'demo2026' });

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const apply = (changes) => call('POST', '/ledger/changes', { changes });

const people = {};
const members = [['阿杰', '🦊'], ['小雨', '🐼'], ['老王', '🐯'], ['Mia', '🐱']].map(([name, avatar]) => {
  people[name] = newId();
  return { op: 'member.create', id: people[name], member: { name, avatar } };
});
await apply(members);
const all = Object.values(people);
const even = (...names) => ({ mode: 'even', memberIds: names.length ? names.map((n) => people[n]) : all });
const exact = (shares) => ({ mode: 'exact', shares: Object.entries(shares).map(([n, amount]) => ({ memberId: people[n], amount })) });

const expenses = [
  [-4, '高铁票', 123600, '阿杰', 'transport', even()],
  [-4, '火锅', 46800, '小雨', 'food', even()],
  [-3, '民宿', 158000, '老王', 'lodging', exact({ 阿杰: 39500, 小雨: 39500, 老王: 52000, Mia: 27000 })],
  [-3, '早餐', 8600, 'Mia', 'food', even()],
  [-3, '景区门票', 52000, '阿杰', 'fun', even()],
  [-2, '午饭', 31200, '小雨', 'food', even('阿杰', '小雨', '老王')],
  [-2, '打车', 5800, 'Mia', 'transport', even('Mia', '小雨')],
  [-2, '奶茶', 6400, '老王', 'food', even()],
  [-1, '烧烤', 42600, '阿杰', 'food', exact({ 阿杰: 12600, 小雨: 9000, 老王: 12000, Mia: 9000 })],
  [-1, '超市', 19850, 'Mia', 'groceries', even()],
  [0, '早餐', 7200, '老王', 'food', even()],
  [0, '咖啡', 9600, '小雨', 'food', even('小雨', 'Mia', '阿杰')],
];
await apply(
  expenses.map(([offset, title, amount, payer, category, split]) => ({
    op: 'expense.create',
    id: newId(),
    expense: { title, amount, payerId: people[payer], date: day(offset), category, split },
  })),
);
await apply([
  { op: 'settlement.create', id: newId(), settlement: { fromId: people.Mia, toId: people['阿杰'], amount: 30000, date: day(-1), note: '微信转账' } },
]);

const second = await call('POST', '/admin/ledgers', { name: '合租 302' });
await call('POST', `/admin/ledgers/${second.id}/passphrases`, { code: 'room302', validUntil: Date.now() + 30 * 86400_000 });

console.log(`✓ 演示账本已创建：${base}/join#demo2026`);
