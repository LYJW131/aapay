import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { OWN_KEY_STORAGE } from '../web/features/assistant/own-key.ts';
import { locale, LOCALE_KEY } from '../web/i18n/locale.ts';
import { clearAll } from '../web/lib/storage.ts';
import { createDemoPlatform } from './platform.ts';
import { seedDemo, type Call } from './seed.ts';
import { CONSOLE_COOKIE } from '../server/auth/cookies.ts';
import { clearCookies, createServer, dropCookie, isServerPath } from './server.ts';
import { installShims } from './shims.ts';
import { clearSaved, loadSaved, writeSaved } from './store.ts';

const [SQL, saved] = await Promise.all([initSqlJs({ locateFile: () => wasmUrl }), loadSaved()]);
const demo = createDemoPlatform(SQL, saved);

let timer: ReturnType<typeof setTimeout> | undefined;
let resetting = false;
const flush = () => {
  clearTimeout(timer);
  if (!resetting) void writeSaved(demo.snapshot());
};
const serve = createServer(demo.platform, () => {
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
});
installShims(serve);
window.addEventListener('pagehide', flush);

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
  resetting = true;
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
