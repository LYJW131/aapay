import { createApp, SERVER_PATHS } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import type { Platform } from '../server/platform.ts';
import type { DemoEnv, ServerSocket } from './platform.ts';

const JAR_KEY = 'aapay-demo:cookies';

type Cookie = { value: string; expires: number | null };

function loadJar(): Map<string, Cookie> {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(JAR_KEY) ?? '{}') as Record<string, Cookie>));
  } catch {
    return new Map();
  }
}

const jar = loadJar();

function saveJar() {
  try {
    localStorage.setItem(JAR_KEY, JSON.stringify(Object.fromEntries(jar)));
  } catch {
  }
}

export function dropCookie(name: string) {
  jar.delete(name);
  saveJar();
}

export function clearCookies() {
  jar.clear();
  try {
    localStorage.removeItem(JAR_KEY);
  } catch {
  }
}

function storeCookie(header: string) {
  const [pair = '', ...attrs] = header.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  const name = pair.slice(0, eq);
  const value = decodeURIComponent(pair.slice(eq + 1));
  let expires: number | null = null;
  for (const attr of attrs) {
    const [key = '', val = ''] = attr.split('=');
    if (key.toLowerCase() === 'max-age') expires = Date.now() + Number(val) * 1000;
    else if (key.toLowerCase() === 'expires' && expires === null) expires = Date.parse(val);
  }
  if (!value || (expires !== null && expires <= Date.now())) jar.delete(name);
  else jar.set(name, { value, expires });
  saveJar();
}

function cookieHeader() {
  const now = Date.now();
  return [...jar]
    .filter(([, c]) => c.expires === null || c.expires > now)
    .map(([name, c]) => `${name}=${encodeURIComponent(c.value)}`)
    .join('; ');
}

export const isServerPath = (pathname: string) =>
  SERVER_PATHS.some((path) => (path.endsWith('/*') ? pathname.startsWith(path.slice(0, -1)) : pathname === path || pathname === `${path}/`));

export function createServer(platform: Platform, onWrite: () => void) {
  const config = loadConfig({ MODE: 'isolated', ADMIN_AUTH: 'none', MCP: 'disabled' });
  const app = createApp(async (c, next) => {
    c.set('config', config);
    c.set('platform', platform);
    const header = c.header;
    c.header = ((name: string, value?: string, options?: { append?: boolean }) => {
      if (name.toLowerCase() === 'set-cookie' && value !== undefined) storeCookie(value);
      else header(name, value, options);
    }) as typeof c.header;
    await next();
  });

  return async function serve(input: RequestInfo | URL, init?: RequestInit, socket?: ServerSocket): Promise<Response> {
    const request = new Request(input, init);
    // 浏览器会从 Request 里丢掉 Cookie、Upgrade 这类受限请求头，这里换成不受限的 Headers 交给应用
    const headers = new Headers(request.headers);
    for (const [key, value] of new Headers(init?.headers)) headers.set(key, value);
    const cookies = cookieHeader();
    if (cookies) headers.set('cookie', cookies);
    Object.defineProperty(request, 'headers', { value: headers });
    const env: DemoEnv = { socket };
    const response = await app.fetch(request, env);
    Object.defineProperty(response, 'url', { value: request.url });
    onWrite();
    return response;
  };
}

export type Serve = ReturnType<typeof createServer>;
