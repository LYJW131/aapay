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

const people = {};
for (const [name, avatar] of [['阿杰', '🦊'], ['小雨', '🐼'], ['老王', '🐯'], ['Mia', '🐱']]) {
  people[name] = (await call('POST', '/ledger/members', { name, avatar })).event.member.id;
}
const all = Object.values(people);
const ids = (...names) => names.map((n) => people[n]);

const expenses = [
  [-4, '高铁票', 123600, '阿杰', all],
  [-4, '火锅', 46800, '小雨', all],
  [-3, '民宿', 158000, '老王', all],
  [-3, '早餐', 8600, 'Mia', all],
  [-3, '景区门票', 52000, '阿杰', all],
  [-2, '午饭', 31200, '小雨', ids('阿杰', '小雨', '老王')],
  [-2, '打车', 5800, 'Mia', ids('Mia', '小雨')],
  [-2, '奶茶', 6400, '老王', all],
  [-1, '烧烤', 42600, '阿杰', all],
  [-1, '超市', 19850, 'Mia', all],
  [0, '早餐', 7200, '老王', all],
  [0, '咖啡', 9600, '小雨', ids('小雨', 'Mia', '阿杰')],
];
for (const [offset, title, amount, payer, participantIds] of expenses) {
  await call('POST', '/ledger/expenses', { title, amount, payerId: people[payer], date: day(offset), participantIds });
}
await call('POST', '/ledger/settlements', { fromId: people.Mia, toId: people['阿杰'], amount: 30000, date: day(-1), note: '微信转账' });

const second = await call('POST', '/admin/ledgers', { name: '合租 302' });
await call('POST', `/admin/ledgers/${second.id}/passphrases`, { code: 'room302', validUntil: Date.now() + 30 * 86400_000 });

console.log(`✓ 演示账本已创建：${base}/join#demo2026`);
