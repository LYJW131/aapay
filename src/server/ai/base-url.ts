const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

// 自带的 Base URL 由服务器代为请求：只接受公网 https，挡住 localhost 与内网 IP 字面量（不防 DNS 指向内网）
export function publicBaseUrl(raw: string): string | null {
  const url = URL.parse(raw.trim());
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_V4.some((re) => re.test(host))) return null;
  if (host.includes(':') && (host === '::1' || host === '::' || /^(fc|fd|fe[89ab])/.test(host) || host.startsWith('::ffff:'))) return null;
  return url.href.replace(/\/+$/, '');
}

export function siteBaseUrl(raw: string): string | null {
  const url = URL.parse(raw.trim());
  return url && /^https?:$/.test(url.protocol) ? url.href.replace(/\/+$/, '') : null;
}
