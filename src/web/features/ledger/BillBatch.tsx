import { CalendarDays, Check, ImagePlus } from 'lucide-react';
import type { Category } from '../../../shared/categories.ts';
import { LIMITS } from '../../../shared/limits.ts';
import { Button } from '../../components/Button.tsx';
import { Label } from '../../components/Card.tsx';
import { common } from '../../i18n/common.ts';
import { expense as t } from '../../i18n/expense.ts';
import { cn } from '../../lib/cn.ts';
import { dayLabel } from '../../lib/dates.ts';

function rowDate(date: string) {
  const { title, sub } = dayLabel(date);
  return title === common.today || title === common.yesterday ? title : `${title} ${sub}`;
}

export interface BillRow {
  key: string;
  title: string;
  amount: string;
  date: string;
  category: Category | null;
  checked: boolean;
  duplicate: boolean;
}

export function BillBatch({
  rows,
  onChange,
  onAddImages,
  onCancel,
  scanning,
}: {
  rows: BillRow[];
  onChange: (rows: BillRow[]) => void;
  onAddImages: () => void;
  onCancel: () => void;
  scanning: boolean;
}) {
  const checked = rows.filter((r) => r.checked).length;
  const update = (key: string, patch: Partial<BillRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <div>
      <Label
        aside={
          <span className="flex gap-1">
            <Button variant="soft" size="sm" loading={scanning} icon={<ImagePlus className="size-4" />} onClick={onAddImages}>
              {scanning ? t.batch.scanning : t.batch.addImages}
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t.batch.cancel}
            </Button>
          </span>
        }
      >
        {t.batch.summary(rows.length, checked)}
      </Label>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-1 rounded-2xl bg-zinc-100/80 py-2 pr-2.5 pl-0.5 dark:bg-white/6">
            <button
              type="button"
              role="checkbox"
              aria-checked={row.checked}
              aria-label={t.batch.include(row.title)}
              onClick={() => update(row.key, { checked: !row.checked })}
              className="flex size-11 shrink-0 items-center justify-center rounded-xl"
            >
              <span
                className={cn(
                  'flex size-[22px] items-center justify-center rounded-[7px] ring-1 transition active:scale-90',
                  row.checked
                    ? 'bg-brand-500 text-white ring-brand-500'
                    : 'bg-white ring-zinc-900/20 dark:bg-white/8 dark:ring-white/25',
                )}
              >
                {row.checked && <Check className="size-4" strokeWidth={3} />}
              </span>
            </button>
            <div className={cn('min-w-0 flex-1 transition-opacity', !row.checked && 'opacity-45')}>
              <input
                value={row.title}
                onChange={(e) => update(row.key, { title: e.target.value })}
                maxLength={LIMITS.title}
                placeholder={t.title}
                aria-label={t.title}
                className="-ml-1.5 w-full rounded-lg bg-transparent px-1.5 py-0.5 text-[15px] font-medium outline-none placeholder:text-zinc-400 focus:bg-white focus:ring-2 focus:ring-brand-500/50 pointer-coarse:text-base dark:focus:bg-white/8"
              />
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <label className="relative -ml-1.5 inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-[13px] whitespace-nowrap text-zinc-500 transition focus-within:ring-2 focus-within:ring-brand-500/50 hover:bg-zinc-900/5 dark:text-zinc-400 dark:hover:bg-white/8">
                  <CalendarDays className="size-3.5" />
                  {rowDate(row.date)}
                  <input
                    type="date"
                    value={row.date}
                    max="9999-12-31"
                    onChange={(e) => e.target.value && update(row.key, { date: e.target.value })}
                    onClick={(e) => e.currentTarget.showPicker?.()}
                    aria-label={t.date}
                    className="absolute inset-0 cursor-pointer text-base opacity-0"
                  />
                </label>
                {row.duplicate && (
                  <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-xs whitespace-nowrap text-amber-700 dark:text-amber-300">{t.batch.duplicate}</span>
                )}
              </div>
            </div>
            <label
              className={cn(
                'flex h-10 w-24 shrink-0 items-center gap-1 rounded-xl bg-white px-2.5 ring-1 ring-zinc-900/5 transition focus-within:ring-2 focus-within:ring-brand-500/60 dark:bg-white/8 dark:ring-white/8',
                !row.checked && 'opacity-45',
              )}
            >
              <span className="text-sm text-zinc-400">¥</span>
              <input
                value={row.amount}
                onChange={(e) => update(row.key, { amount: e.target.value })}
                inputMode="decimal"
                placeholder="0.00"
                aria-label={t.amount}
                className="tabular min-w-0 flex-1 bg-transparent text-right text-[15px] font-semibold outline-none placeholder:text-zinc-400 pointer-coarse:text-base"
              />
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
