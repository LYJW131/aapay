import { motion } from 'motion/react';
import { useId } from 'react';
import { cn } from '../lib/cn.ts';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cn('flex rounded-xl bg-zinc-100/80 p-0.5 dark:bg-white/6', className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative h-8 min-w-0 flex-1 rounded-[10px] px-2 text-[13px] font-medium whitespace-nowrap transition-colors',
              active ? 'text-zinc-900 dark:text-white' : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
            )}
          >
            {active && (
              <motion.span
                layoutId={id}
                transition={{ type: 'spring', bounce: 0.15, duration: 0.35 }}
                className="absolute inset-0 rounded-[10px] bg-white shadow-sm ring-1 ring-zinc-900/5 dark:bg-white/12 dark:ring-white/8"
              />
            )}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
