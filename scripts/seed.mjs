import { DEMO_CODES, seedDemo } from '../src/demo/seed.ts';

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
  if (!res.ok && res.status !== 302) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

await seedDemo(call);
for (const code of Object.values(DEMO_CODES)) console.log(`✓ 演示账本已创建：${base}/join#${code}`);
