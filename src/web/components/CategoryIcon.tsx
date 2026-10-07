import { Tag } from 'lucide-react';
import { CATEGORY_EMOJI, CATEGORY_LABELS, type Category } from '../../shared/categories.ts';
import { locale } from '../i18n/locale.ts';
import { cn } from '../lib/cn.ts';

const TINTS: Record<Category, string> = {
  food: 'bg-orange-100 dark:bg-orange-400/15',
  groceries: 'bg-lime-100 dark:bg-lime-400/15',
  transport: 'bg-sky-100 dark:bg-sky-400/15',
  lodging: 'bg-indigo-100 dark:bg-indigo-400/15',
  fun: 'bg-fuchsia-100 dark:bg-fuchsia-400/15',
  shopping: 'bg-pink-100 dark:bg-pink-400/15',
  housing: 'bg-amber-100 dark:bg-amber-400/15',
  other: 'bg-slate-100 dark:bg-slate-400/15',
};

const SIZES = {
  sm: 'size-7 text-sm [&>svg]:size-3.5',
  md: 'size-11 text-[22px] [&>svg]:size-5',
};

export const categoryName = (category: Category) => CATEGORY_LABELS[locale][category];

export function CategoryIcon({ category, size = 'md', className }: { category: Category | null; size?: keyof typeof SIZES; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full leading-none select-none',
        category ? TINTS[category] : 'bg-zinc-100 text-zinc-400 dark:bg-white/6 dark:text-zinc-500',
        SIZES[size],
        className,
      )}
    >
      {category ? CATEGORY_EMOJI[category] : <Tag />}
    </span>
  );
}
