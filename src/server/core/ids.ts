const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 生成 URL 安全的随机 ID（默认 16 位 base62，约 95 bit 熵） */
export function newId(size = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let id = '';
  for (const b of bytes) id += ALPHABET[b % 62];
  return id;
}

/** 生成会话令牌（32 字节，base64url） */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
