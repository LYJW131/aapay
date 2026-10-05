import { defineMessages, LOCALES, matchLocale, type Locale } from '../../shared/i18n.ts';
import { load, save } from '../lib/storage.ts';

export const LOCALE_KEY = 'aapay:locale';

function detect(): Locale {
  const saved = load<string | null>(LOCALE_KEY, null);
  if (saved && (LOCALES as readonly string[]).includes(saved)) return saved as Locale;
  for (const tag of navigator.languages ?? [navigator.language]) {
    const found = matchLocale(tag);
    if (found) return found;
  }
  return 'en';
}

export const locale = detect();
document.documentElement.lang = locale;

// 文案在模块加载时按语言取定，切换语言直接刷新页面
export function setLocale(next: Locale) {
  if (next === locale) return;
  save(LOCALE_KEY, next);
  window.location.reload();
}

export const messages = <T>(catalog: { 'zh-CN': T; en: NoInfer<T> }): T => defineMessages(catalog)[locale];
