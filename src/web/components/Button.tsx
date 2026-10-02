import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { useDelayed } from '../lib/hooks.ts';
import { Spinner } from './Spinner.tsx';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const variants: Record<Variant, string> = {
  primary:
    'bg-gradient-to-br from-brand-500 to-brand-600 text-white shadow-[0_6px_16px_-6px] shadow-brand-500/60 hover:brightness-110 active:brightness-95',
  secondary:
    'bg-white text-zinc-800 ring-1 ring-zinc-900/10 hover:bg-zinc-50 dark:bg-white/8 dark:text-zinc-100 dark:ring-white/10 dark:hover:bg-white/12',
  soft: 'bg-brand-500/10 text-brand-600 hover:bg-brand-500/15 dark:text-brand-300 dark:bg-brand-400/12',
  ghost: 'text-zinc-600 hover:bg-zinc-900/5 dark:text-zinc-300 dark:hover:bg-white/8',
  danger: 'bg-rose-500/10 text-rose-600 hover:bg-rose-500/15 dark:text-rose-400',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] rounded-xl gap-1.5',
  md: 'h-11 px-4 text-[15px] rounded-2xl gap-2',
  lg: 'h-13 px-6 text-base rounded-2xl gap-2',
  icon: 'size-10 rounded-full',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading = false, icon, className, children, disabled, ...rest }: Props) {
  const spinning = useDelayed(loading);
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center font-medium whitespace-nowrap transition duration-150 active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100',
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {spinning ? <Spinner className="size-4" /> : icon}
      {children}
    </button>
  );
}
