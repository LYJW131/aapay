import type { Member } from '../../shared/types.ts';
import { cn } from '../lib/cn.ts';

const TINTS = [
  'bg-rose-100 dark:bg-rose-400/15',
  'bg-amber-100 dark:bg-amber-400/15',
  'bg-lime-100 dark:bg-lime-400/15',
  'bg-emerald-100 dark:bg-emerald-400/15',
  'bg-cyan-100 dark:bg-cyan-400/15',
  'bg-sky-100 dark:bg-sky-400/15',
  'bg-indigo-100 dark:bg-indigo-400/15',
  'bg-fuchsia-100 dark:bg-fuchsia-400/15',
];

function tint(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}

const SIZES = {
  '2xs': 'size-5 text-[11px]',
  xs: 'size-6 text-sm',
  sm: 'size-8 text-base',
  md: 'size-11 text-[22px]',
  lg: 'size-14 text-3xl',
  xl: 'size-20 text-5xl',
};

export function Avatar({
  member,
  size = 'md',
  className,
}: {
  member: Pick<Member, 'id' | 'name' | 'avatar'> | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const label = member?.avatar || member?.name.slice(0, 1) || '?';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full leading-none text-zinc-700 select-none dark:text-zinc-200',
        member ? tint(member.id) : 'bg-zinc-100 dark:bg-white/8',
        SIZES[size],
        className,
      )}
      aria-hidden
    >
      {label}
    </span>
  );
}
