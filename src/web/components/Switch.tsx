import { cn } from '../lib/cn.ts';

export function Switch({ checked, onChange, label, className }: { checked: boolean; onChange: (v: boolean) => void; label: string; className?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-200',
        checked ? 'bg-brand-500' : 'bg-zinc-300 dark:bg-white/15',
        className,
      )}
    >
      <span
        className={cn(
          'size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[var(--ease-spring)]',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
