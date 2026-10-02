import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';

export const SESSION_COOKIE = 'aapay_session';
export const CONSOLE_COOKIE = 'aapay_console';

export function setSessionCookie(c: Context, name: string, token: string, expiresAt: number) {
  setCookie(c, name, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https',
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(c: Context, name: string) {
  deleteCookie(c, name, { path: '/' });
}
