import { Languages } from 'lucide-react';
import { common } from '../i18n/common.ts';
import { locale, setLocale } from '../i18n/locale.ts';
import { cn } from '../lib/cn.ts';

export function LanguageSwitch({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')}
      aria-label={common.language}
      title={common.language}
      className={cn(
        'inline-flex items-center gap-1.5 text-sm text-zinc-500 transition hover:text-brand-600 dark:text-zinc-400',
        className,
      )}
    >
      <Languages className="size-4" />
      {common.switchLanguage}
    </button>
  );
}
