import { Check, ImagePlus } from 'lucide-react';
import { LIMITS } from '../../../shared/limits.ts';
import { Button } from '../../components/Button.tsx';
import { Label } from '../../components/Card.tsx';
import { cn } from '../../lib/cn.ts';

export interface BillRow {
  key: string;
  title: string;
  amount: string;
  date: string;
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
              {scanning ? '识别中' : '加图片'}
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              取消
            </Button>
          </span>
        }
      >
        识别到 {rows.length} 笔 · 已选 {checked}
      </Label>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.key}
            className={cn(
              'flex items-start gap-3 rounded-2xl bg-zinc-100/80 px-3 py-2.5 transition dark:bg-white/6',
              !row.checked && 'opacity-55',
            )}
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={row.checked}
              aria-label={`记入 ${row.title || '这笔'}`}
              onClick={() => update(row.key, { checked: !row.checked })}
              className={cn(
                'mt-1 flex size-5 shrink-0 items-center justify-center rounded-md ring-1 transition',
                row.checked
                  ? 'bg-brand-500 text-white ring-brand-500'
                  : 'bg-white ring-zinc-900/15 dark:bg-white/8 dark:ring-white/20',
              )}
            >
              {row.checked && <Check className="size-3.5" strokeWidth={3} />}
            </button>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-baseline gap-2">
                <input
                  value={row.title}
                  onChange={(e) => update(row.key, { title: e.target.value })}
                  maxLength={LIMITS.title}
                  placeholder="用途"
                  aria-label="用途"
                  className="min-w-0 flex-1 bg-transparent text-[15px] font-medium outline-none placeholder:text-zinc-400 pointer-coarse:text-base"
                />
                <span className="-mr-1.5 text-sm text-zinc-400">¥</span>
                <input
                  value={row.amount}
                  onChange={(e) => update(row.key, { amount: e.target.value })}
                  inputMode="decimal"
                  placeholder="0.00"
                  aria-label="金额"
                  style={{ width: `${(row.amount || '0.00').length + 0.5}ch` }}
                  className="tabular bg-transparent text-right text-[15px] font-semibold outline-none placeholder:text-zinc-400 pointer-coarse:text-base"
                />
              </div>
              <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <input
                  type="date"
                  value={row.date}
                  max="9999-12-31"
                  onChange={(e) => e.target.value && update(row.key, { date: e.target.value })}
                  aria-label="日期"
                  className="tabular bg-transparent outline-none pointer-coarse:text-base"
                />
                {row.duplicate && (
                  <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-amber-700 dark:text-amber-300">可能已记过</span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
