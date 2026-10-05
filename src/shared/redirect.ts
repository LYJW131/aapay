const BASE = 'http://aapay.invalid';

// 登录后跳回的地址只能是站内路径，避免开放跳转
export function localPath(value: string | null | undefined): string {
  if (!value) return '/';
  try {
    const url = new URL(value, BASE);
    return url.origin === BASE ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}
