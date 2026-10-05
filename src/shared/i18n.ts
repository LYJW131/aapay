export const LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'zh-CN';

export function matchLocale(tag: string): Locale | null {
  const lang = tag.trim().toLowerCase();
  if (lang === 'zh' || lang.startsWith('zh-')) return 'zh-CN';
  if (lang === 'en' || lang.startsWith('en-')) return 'en';
  return null;
}

export function negotiateLocale(acceptLanguage: string | undefined): Locale {
  const ranked = (acceptLanguage ?? '')
    .split(',')
    .map((part, i) => {
      const [tag = '', ...params] = part.split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag, q: q ? Number(q.slice(2)) || 0 : 1, i };
    })
    .filter((r) => r.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of ranked) {
    const found = matchLocale(tag);
    if (found) return found;
  }
  return DEFAULT_LOCALE;
}

export function defineMessages<T>(messages: { 'zh-CN': T; en: NoInfer<T> }) {
  return messages;
}
