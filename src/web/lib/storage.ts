// 隐私模式下 localStorage 可能抛错
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function clearAll(keep: string[] = []) {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('aapay:') && !keep.includes(key)) localStorage.removeItem(key);
  } catch {
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
  }
}
