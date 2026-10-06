const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const ID_PATTERN = /^[0-9A-Za-z_-]{8,64}$/;

export function newId(size = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let id = '';
  for (const b of bytes) id += ALPHABET[b % 62];
  return id;
}
