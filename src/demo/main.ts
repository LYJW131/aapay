import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { OWN_KEY_STORAGE } from '../web/features/assistant/own-key.ts';
import { locale, LOCALE_KEY } from '../web/i18n/locale.ts';
import { clearAll } from '../web/lib/storage.ts';
import { createDemoPlatform } from './platform.ts';
import { seedDemo, type Call } from './seed.ts';
import { CONSOLE_COOKIE } from '../server/auth/cookies.ts';
import { clearCookies, createServer, dropCookie, isServerPath, type Serve } from './server.ts';
import { installShims } from './shims.ts';
import { clearSaved, loadSaved, writeSaved } from './store.ts';

// 每个标签页各有一份内存里的数据库，同时写会互相覆盖：新打开的标签页接管，旧的先把数据写回再让出
const tabs = 'locks' in navigator ? new BroadcastChannel('aapay-demo') : null;
let release = () => {};
if (tabs) {
  const ask = () => tabs.postMessage('takeover');
  ask();
  const retry = setInterval(ask, 1000);
  await new Promise<void>((acquired) => {
    void navigator.locks.request('aapay-demo', () => {
      acquired();
      return new Promise<void>((done) => (release = done));
    });
  });
  clearInterval(retry);
}

const [SQL, saved] = await Promise.all([initSqlJs({ locateFile: () => wasmUrl }), loadSaved()]);
const demo = createDemoPlatform(SQL, saved);

let timer: ReturnType<typeof setTimeout> | undefined;
let frozen = false;
const flush = () => {
  clearTimeout(timer);
  if (!frozen) void writeSaved(demo.snapshot());
};
const live = createServer(demo.platform, () => {
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
});
const serve: Serve = (input, init, socket) => (frozen ? Promise.resolve(new Response(null, { status: 503 })) : live(input, init, socket));
installShims(serve);
window.addEventListener('pagehide', flush);

if (tabs) {
  tabs.onmessage = async () => {
    if (frozen) return;
    clearTimeout(timer);
    await writeSaved(demo.snapshot());
    frozen = true;
    release();
    const { mountTakenOver } = await import('./Banner.tsx');
    mountTakenOver();
  };
}

const call: Call = async (method, path, body) => {
  const res = await serve(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  if (!res.ok && res.status !== 302) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};

export async function resetDemo() {
  frozen = true;
  clearTimeout(timer);
  await clearSaved();
  clearCookies();
  clearAll([LOCALE_KEY, OWN_KEY_STORAGE]);
  window.location.assign('/');
}

if (demo.fresh) {
  clearCookies();
  clearAll([LOCALE_KEY, OWN_KEY_STORAGE]);
  await seedDemo(call, locale);
  dropCookie(CONSOLE_COOKIE);
  flush();
}

// GitHub Pages 把 /api/admin/login 这类整页跳转交给 404.html，在这里转给浏览器内的服务端处理
if (isServerPath(window.location.pathname)) {
  const res = await serve(window.location.href);
  const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
  flush();
  window.location.replace(next ?? '/');
} else {
  await import('../web/main.tsx');
  const { mountBanner } = await import('./Banner.tsx');
  mountBanner(resetDemo);
}
