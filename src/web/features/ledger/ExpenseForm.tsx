import { Camera, Check, Minus, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CATEGORIES, CATEGORY_EMOJI, guessCategory, type Category } from '../../../shared/categories.ts';
import { newId } from '../../../shared/ids.ts';
import { computeShares, matchesInput, splitOf } from '../../../shared/ledger.ts';
import { centsToInput, formatMoney, parseAmount, splitByWeights } from '../../../shared/money.ts';
import { LIMITS } from '../../../shared/limits.ts';
import type { ExpenseInput, ExpenseSplit } from '../../../shared/schema.ts';
import type { Expense, Member } from '../../../shared/types.ts';
import { Avatar } from '../../components/Avatar.tsx';
import { AutoHeight } from '../../components/AutoHeight.tsx';
import { Button } from '../../components/Button.tsx';
import { Label } from '../../components/Card.tsx';
import { categoryName } from '../../components/CategoryIcon.tsx';
import { Collapse } from '../../components/Collapse.tsx';
import { Hint } from '../../components/Hint.tsx';
import { Segmented } from '../../components/Segmented.tsx';
import { common } from '../../i18n/common.ts';
import { expense as t } from '../../i18n/expense.ts';
import { ApiError, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { addDays, today } from '../../lib/dates.ts';
import { compressImage } from '../../lib/image.ts';
import { load, save } from '../../lib/storage.ts';
import { useAssistant } from '../assistant/context.ts';
import { useLedger } from './context.tsx';
import { undoAction } from './undo.ts';

const MAX_IMAGES = 6;
const MAX_SUGGESTIONS = 20;
const MAX_WEIGHT = 99;

type SplitMode = 'even' | 'weights' | 'amounts';

const SPLIT_MODES: { value: SplitMode; label: string }[] = [
  { value: 'even', label: t.form.splitModes.even },
  { value: 'weights', label: t.form.splitModes.weights },
  { value: 'amounts', label: t.form.splitModes.amounts },
];

const payerListeners = new Set<() => void>();

export function saveDefaultPayer(storageKey: string, id: string) {
  save(storageKey, id);
  for (const l of payerListeners) l();
}

export function useDefaultPayer(storageKey: string) {
  return useSyncExternalStore(
    (cb) => {
      payerListeners.add(cb);
      return () => void payerListeners.delete(cb);
    },
    () => load<string | null>(storageKey, null),
  );
}

function seedSplit(expense: Expense | undefined, initial: ExpenseInput | undefined, members: readonly Member[]): ExpenseSplit | null {
  if (expense) return splitOf(expense, members);
  if (!initial) return null;
  return initial.split.mode === 'even' ? initial.split : splitOf({ amount: initial.amount, shares: initial.split.shares }, members);
}

const amountInputs = (shares: readonly { memberId: string; amount: number }[]) =>
  Object.fromEntries(shares.map((s) => [s.memberId, centsToInput(s.amount)]));

export function ExpenseForm({
  expense: latest,
  initial,
  onSave,
  onReload,
  onDone,
}: {
  expense?: Expense;
  initial?: ExpenseInput;
  onSave?: (input: ExpenseInput) => void;
  onReload?: () => void;
  onDone?: () => void;
}) {
  const { snapshot, store, key, memberById } = useLedger();
  const assistant = useAssistant();
  const { members } = snapshot;
  const [expense] = useState(latest);
  const seed = expense ?? initial;

  const [amount, setAmount] = useState(seed ? centsToInput(seed.amount) : '');
  const [title, setTitle] = useState(seed?.title ?? '');
  const [pickedCategory, setPickedCategory] = useState<Category | null | undefined>(seed ? seed.category : undefined);
  const autoCategory = pickedCategory === undefined;
  const category = autoCategory ? guessCategory(title) : pickedCategory;
  const [date, setDate] = useState(seed?.date ?? today());
  const defaultPayer = useDefaultPayer(key('payer'));
  const [editedPayer, setEditedPayer] = useState(seed?.payerId ?? '');
  const payerId = seed ? editedPayer : defaultPayer && memberById.has(defaultPayer) ? defaultPayer : '';
  const choosePayer = (id: string) => (seed ? setEditedPayer(id) : saveDefaultPayer(key('payer'), id));
  const [picked, setPicked] = useState(() =>
    expense
      ? new Set(expense.shares.map((s) => s.memberId))
      : initial
        ? new Set(initial.split.mode === 'even' ? initial.split.memberIds : initial.split.shares.map((s) => s.memberId))
        : null,
  );
  // 新记一笔时只记住没选的人，之后加入的成员（包括表单打开期间）默认参与
  const [excluded, setExcluded] = useState(() => new Set(load<string[]>(key('excluded-participants'), [])));
  const selected = picked ?? new Set(members.filter((m) => !excluded.has(m.id)).map((m) => m.id));
  const choose = (next: Set<string>) => {
    if (picked) return setPicked(next);
    const out = members.filter((m) => !next.has(m.id)).map((m) => m.id);
    setExcluded(new Set(out));
    save(key('excluded-participants'), out);
  };
  const [original] = useState(() => seedSplit(expense, initial, members));
  const [mode, setMode] = useState<SplitMode>(original?.mode === 'exact' ? 'amounts' : 'even');
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>(() => (original?.mode === 'exact' ? amountInputs(original.shares) : {}));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [done, setDone] = useState(false);
  const changedElsewhere = !!expense && !!latest && latest.updatedAt !== expense.updatedAt && !saving && !deleting && !done;
  const [snapping, setSnapping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const canSnap = assistant.available && !seed;

  const cents = parseAmount(amount);
  const participants = members.filter((m) => selected.has(m.id));
  const participantIds = participants.map((m) => m.id);
  const allSelected = members.length > 0 && participantIds.length === members.length;
  const weightOf = (id: string) => weights[id] ?? 1;
  const evenShares = cents ? computeShares(cents, { mode: 'even', memberIds: participantIds }, members) : [];
  const weightShares = cents ? splitByWeights(cents, participantIds.map((id) => ({ memberId: id, weight: weightOf(id) }))) : [];
  const typed = participantIds.map((id) => ({ memberId: id, amount: parseAmount(amounts[id] ?? '') }));
  const diff = cents === null ? null : cents - typed.reduce((sum, s) => sum + (s.amount ?? 0), 0);
  const unbalanced = mode === 'amounts' && participantIds.length > 0 && diff !== null && diff !== 0;

  const liveSuggestions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of snapshot.expenses.slice(0, 200)) counts.set(e.title, (counts.get(e.title) ?? 0) + 1);
    const recent = [...counts].sort((a, b) => b[1] - a[1]).map(([title]) => title);
    return [...new Set([...recent, ...t.form.suggestions])].slice(0, MAX_SUGGESTIONS);
  }, [snapshot.expenses]);
  // 弹窗里提交后表单随弹窗关掉，而账目更新常先于弹窗退场到达，建议跟着重排会在关闭时闪一下
  const [openedSuggestions] = useState(liveSuggestions);
  const suggestions = onDone ? openedSuggestions : liveSuggestions;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    choose(next);
  };

  const changeMode = (next: SplitMode) => {
    if (next === mode) return;
    const balanced = diff === 0 && typed.every((s) => s.amount !== null);
    if (next === 'amounts' && cents && !balanced) setAmounts(amountInputs(mode === 'weights' ? weightShares : evenShares));
    setMode(next);
  };

  function buildSplit(): ExpenseSplit | null {
    if (mode === 'even') return { mode: 'even', memberIds: participantIds };
    if (mode === 'weights') {
      if (weightShares.some((s) => s.amount < 1)) {
        toast.error(t.form.shareTooSmall);
        return null;
      }
      return { mode: 'exact', shares: weightShares };
    }
    const shares = typed.flatMap((s) => (s.amount === null ? [] : [{ memberId: s.memberId, amount: s.amount }]));
    if (shares.length < typed.length) {
      toast.error(t.form.amountsRequired);
      return null;
    }
    return diff === 0 ? { mode: 'exact', shares } : null;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!cents) return toast.error(t.form.invalidAmount);
    if (!title.trim()) return toast.error(t.form.titleRequired);
    if (!payerId) return toast.error(t.form.payerRequired);
    if (participantIds.length === 0) return toast.error(t.form.participantsRequired);
    const split = buildSplit();
    if (!split) return;

    const input: ExpenseInput = { title: title.trim(), amount: cents, payerId, date, category, split };
    if (onSave) {
      onSave(input);
      return onDone?.();
    }
    setSaving(true);
    try {
      if (expense) {
        if (matchesInput(expense, input, members)) return onDone?.();
        await store.apply([{ op: 'expense.update', id: expense.id, expense: input, ifUpdatedAt: expense.updatedAt }]);
        setDone(true);
        toast.success(t.form.saved);
      } else {
        const { undo } = await store.apply([{ op: 'expense.create', id: newId(), expense: input }]);
        toast.success(t.form.added(input.title, formatMoney(cents)), { action: undoAction(store, undo) });
        // 在弹窗里时表单随弹窗关掉，这时清空会让退场动画里的内容先变一下
        if (!onDone) {
          setAmount('');
          setTitle('');
          setPickedCategory(undefined);
          setMode('even');
          setWeights({});
          setAmounts({});
        }
      }
      onDone?.();
    } catch (err) {
      conflicted(err);
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function conflicted(err: unknown) {
    if (expense && err instanceof ApiError && err.status === 409) void store.refresh();
  }

  async function snap(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (files.length === 0) return;
    if (files.length > MAX_IMAGES) toast(t.form.tooManyImages(MAX_IMAGES));
    setSnapping(true);
    const results = await Promise.allSettled(files.slice(0, MAX_IMAGES).map((f) => compressImage(f)));
    setSnapping(false);
    const images = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (images.length < results.length) toast.error(t.form.unreadableImage);
    if (images.length === 0) return;
    assistant.open({ images, send: true });
    onDone?.();
  }

  async function remove() {
    if (!expense) return;
    setDeleting(true);
    try {
      const { undo } = await store.apply([{ op: 'expense.delete', id: expense.id, ifUpdatedAt: expense.updatedAt }]);
      toast.success(t.form.deleted(expense.title), { action: undoAction(store, undo) });
      onDone?.();
    } catch (err) {
      conflicted(err);
      toast.error(errorMessage(err));
      setDeleting(false);
    }
  }

  const yesterday = addDays(today(), -1);
  const money = (value: number | null | undefined) => (cents && value !== null && value !== undefined ? formatMoney(value) : '—');

  let summaryLabel: ReactNode = t.form.customSplit;
  let summaryValue: ReactNode = money(cents);
  if (participantIds.length === 0) {
    summaryLabel = t.form.choosePeople;
    summaryValue = '—';
  } else if (mode === 'even') {
    summaryLabel = t.form.perPerson(participantIds.length);
    summaryValue = (
      <>
        {money(evenShares.at(-1)?.amount)}
        {evenShares.length > 1 && evenShares[0]!.amount !== evenShares.at(-1)!.amount && (
          <span className="ml-1 text-xs font-normal text-zinc-400">{t.form.unevenShares}</span>
        )}
      </>
    );
  } else if (unbalanced) {
    summaryLabel = diff! > 0 ? t.form.remaining : t.form.over;
    summaryValue = formatMoney(Math.abs(diff!));
  }

  return (
    <>
      <Collapse open={members.length === 0}>
        <p className="py-6 text-center text-sm text-zinc-500">{t.form.noMembers}</p>
      </Collapse>
      <Collapse open={members.length > 0}>
        <Collapse open={changedElsewhere} className="pb-4">
          <div className="flex items-center gap-3 rounded-2xl bg-amber-500/12 py-2 pr-2 pl-4 text-sm text-amber-800 dark:text-amber-200">
            <span className="min-w-0 flex-1">{t.form.changedElsewhere}</span>
            <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} onClick={onReload}>
              {t.form.loadLatest}
            </Button>
          </div>
        </Collapse>
        <form onSubmit={submit} className="space-y-5 pt-1 pb-1">
          {canSnap && <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={snap} />}
          <div className="flex items-baseline gap-2 rounded-2xl bg-zinc-100/80 px-4 py-3 ring-brand-500/60 transition focus-within:bg-white focus-within:ring-2 dark:bg-white/6 dark:focus-within:bg-white/8">
            <span className="text-2xl font-semibold text-zinc-400">¥</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              aria-label={t.amount}
              autoFocus={!expense && window.matchMedia('(min-width: 1024px)').matches}
              className="tabular min-w-0 flex-1 bg-transparent text-[32px] leading-tight font-semibold tracking-tight outline-none placeholder:text-zinc-300 dark:placeholder:text-zinc-600"
            />
            {canSnap && (
              <Button
                variant="soft"
                size="sm"
                className="self-center"
                loading={snapping}
                icon={<Camera className="size-4" />}
                onClick={() => fileInput.current?.click()}
              >
                {t.form.photo}
              </Button>
            )}
          </div>

          <div>
            <Label aside={<span className="tabular text-xs text-zinc-400">{title.length}/{LIMITS.title}</span>}>{t.title}</Label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={LIMITS.title}
              placeholder={t.form.titlePlaceholder}
              className="field"
            />
            <AutoHeight className="-m-1 p-1">
              <TwoLines className="mt-2 flex flex-wrap gap-1.5" items={suggestions}>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setTitle(s)}
                    className={cn(
                      'rounded-full px-2.5 py-1 text-xs transition',
                      title === s
                        ? 'bg-brand-500 text-white'
                        : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-white/6 dark:text-zinc-300 dark:hover:bg-white/10',
                    )}
                  >
                    {s}
                  </button>
                ))}
              </TwoLines>
            </AutoHeight>
          </div>

          <div>
            <Label>
              <span className="flex items-center gap-1.5">
                {t.form.category}
                <Hint>{t.form.categoryHint}</Hint>
              </span>
            </Label>
            <CategoryPicker
              value={category}
              auto={autoCategory}
              onChange={(c) => setPickedCategory(c === category ? null : c)}
            />
          </div>

          <div>
            <Label>{t.date}</Label>
            <div className="flex gap-2">
              {[
                [today(), common.today],
                [yesterday, common.yesterday],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDate(value!)}
                  className={cn(
                    'h-11 rounded-2xl px-4 text-sm font-medium transition',
                    date === value
                      ? 'bg-brand-500/12 text-brand-600 ring-1 ring-brand-500/40 dark:text-brand-300'
                      : 'bg-zinc-100/80 text-zinc-600 hover:bg-zinc-200/70 dark:bg-white/6 dark:text-zinc-300',
                  )}
                >
                  {label}
                </button>
              ))}
              <input
                type="date"
                value={date}
                max="9999-12-31"
                onChange={(e) => e.target.value && setDate(e.target.value)}
                className="field tabular min-w-0 flex-1 px-3 text-center"
                aria-label={t.form.pickDate}
              />
            </div>
          </div>

          <div>
            <Label>{t.paidBy}</Label>
            <AutoHeight className="-m-1 p-1">
              <div className="flex flex-wrap gap-2">
                {members.map((m) => (
                  <MemberChip key={m.id} active={payerId === m.id} onClick={() => choosePayer(m.id)} member={m} />
                ))}
              </div>
            </AutoHeight>
          </div>

          <div>
            <Label
              aside={
                <button
                  type="button"
                  onClick={() => choose(new Set(allSelected ? [] : members.map((m) => m.id)))}
                  className="rounded-full px-2 py-0.5 text-xs text-brand-600 hover:bg-brand-500/10 dark:text-brand-300"
                >
                  {allSelected ? t.form.selectNone : t.form.selectAll}
                </button>
              }
            >
              <span className="flex items-center gap-1.5">
                {t.form.splitBetween} · {participantIds.length}/{members.length}
                <Hint>{t.form.splitHint}</Hint>
              </span>
            </Label>
            <Segmented value={mode} options={SPLIT_MODES} onChange={changeMode} label={t.form.splitMode} className="mb-3" />
            <AutoHeight className="-m-1 p-1">
              <div className="flex flex-wrap gap-2">
                {members.map((m) => (
                  <MemberChip key={m.id} active={selected.has(m.id)} onClick={() => toggle(m.id)} member={m} multi />
                ))}
              </div>
              {mode !== 'even' && participants.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {participants.map((m, i) =>
                    mode === 'weights' ? (
                      <WeightRow
                        key={m.id}
                        member={m}
                        weight={weightOf(m.id)}
                        share={money(weightShares[i]?.amount)}
                        onChange={(w) => setWeights({ ...weights, [m.id]: w })}
                      />
                    ) : (
                      <AmountRow
                        key={m.id}
                        member={m}
                        value={amounts[m.id] ?? ''}
                        onChange={(v) => setAmounts({ ...amounts, [m.id]: v })}
                      />
                    ),
                  )}
                </ul>
              )}
            </AutoHeight>
          </div>

          <div
            className={cn(
              'flex items-center justify-between rounded-2xl px-4 py-3 text-sm transition-colors',
              unbalanced ? 'bg-amber-500/10' : 'bg-brand-500/6 dark:bg-brand-400/8',
            )}
          >
            <span className={unbalanced ? 'text-amber-700 dark:text-amber-300' : 'text-zinc-500 dark:text-zinc-400'}>{summaryLabel}</span>
            <span className={cn('tabular font-semibold', unbalanced ? 'text-amber-700 dark:text-amber-300' : 'text-brand-600 dark:text-brand-300')}>
              {summaryValue}
            </span>
          </div>

          <div className="flex gap-2">
            {expense && (
              <Button variant="danger" size="lg" onClick={remove} loading={deleting} icon={<Trash2 className="size-4" />}>
                {t.form.delete}
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="flex-1"
              loading={saving}
              disabled={unbalanced}
              icon={<Check className="size-4" />}
            >
              {expense || onSave ? t.form.saveChanges : t.form.add}
            </Button>
          </div>
        </form>
      </Collapse>
    </>
  );
}

function CategoryPicker({ value, auto, onChange }: { value: Category | null; auto: boolean; onChange: (c: Category) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    const chip = value && el?.querySelector<HTMLElement>(`[data-category="${value}"]`);
    if (!el || !chip || el.scrollWidth <= el.clientWidth) return;
    const left = chip.offsetLeft - el.offsetLeft;
    if (left < el.scrollLeft || left + chip.offsetWidth > el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: left - (el.clientWidth - chip.offsetWidth) / 2, behavior: 'smooth' });
    }
  }, [value]);
  return (
    <div ref={box} className="-mx-5 -my-1 flex scroll-px-5 gap-1.5 overflow-x-auto px-5 py-1 [scrollbar-width:none] lg:-mx-1 lg:flex-wrap lg:px-1">
      {CATEGORIES.map((c) => {
        const active = value === c;
        return (
          <button
            key={c}
            type="button"
            data-category={c}
            aria-pressed={active}
            onClick={() => onChange(c)}
            className={cn(
              'flex h-8 shrink-0 items-center gap-1 rounded-full pr-3 pl-2 text-[13px] font-medium whitespace-nowrap transition active:scale-95 pointer-coarse:h-9',
              active
                ? 'bg-brand-500/12 text-brand-600 ring-1 ring-brand-500/40 dark:text-brand-300'
                : 'bg-zinc-100/80 text-zinc-600 hover:bg-zinc-200/70 dark:bg-white/6 dark:text-zinc-300 dark:hover:bg-white/10',
            )}
          >
            <span className="text-[15px] leading-none">{CATEGORY_EMOJI[c]}</span>
            {categoryName(c)}
            {active && auto && <span className="ml-0.5 text-[11px] font-normal opacity-60">· {t.form.auto}</span>}
          </button>
        );
      })}
    </div>
  );
}

function WeightRow({ member, weight, share, onChange }: { member: Member; weight: number; share: string; onChange: (weight: number) => void }) {
  const step = 'flex size-9 items-center justify-center rounded-full text-zinc-600 transition hover:bg-zinc-900/5 active:scale-90 disabled:opacity-30 dark:text-zinc-300 dark:hover:bg-white/8';
  return (
    <li className="flex h-12 items-center gap-2.5 rounded-2xl bg-zinc-100/80 pr-1.5 pl-2 dark:bg-white/6">
      <Avatar member={member} size="sm" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{member.name}</span>
      <span className="tabular text-sm text-zinc-500 dark:text-zinc-400">{share}</span>
      <div className="flex items-center rounded-full bg-white ring-1 ring-zinc-900/5 dark:bg-white/8 dark:ring-white/8">
        <button type="button" className={step} disabled={weight <= 1} aria-label={t.form.fewer(member.name)} onClick={() => onChange(weight - 1)}>
          <Minus className="size-4" />
        </button>
        <span className="tabular w-6 text-center text-sm font-semibold" aria-label={t.form.weightOf(member.name)}>
          {weight}
        </span>
        <button type="button" className={step} disabled={weight >= MAX_WEIGHT} aria-label={t.form.more(member.name)} onClick={() => onChange(weight + 1)}>
          <Plus className="size-4" />
        </button>
      </div>
    </li>
  );
}

function AmountRow({ member, value, onChange }: { member: Member; value: string; onChange: (value: string) => void }) {
  const invalid = value.trim() !== '' && parseAmount(value) === null;
  return (
    <li className="flex h-12 items-center gap-2.5 rounded-2xl bg-zinc-100/80 pr-1.5 pl-2 dark:bg-white/6">
      <Avatar member={member} size="sm" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{member.name}</span>
      <label
        className={cn(
          'flex h-9 w-28 shrink-0 items-center gap-1 rounded-xl bg-white px-2.5 ring-1 transition focus-within:ring-2 dark:bg-white/8',
          invalid ? 'ring-rose-500/60 focus-within:ring-rose-500/60' : 'ring-zinc-900/5 focus-within:ring-brand-500/60 dark:ring-white/8',
        )}
      >
        <span className="text-sm text-zinc-400">¥</span>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          aria-label={t.form.amountOf(member.name)}
          aria-invalid={invalid}
          className="tabular min-w-0 flex-1 bg-transparent text-right text-[15px] font-semibold outline-none placeholder:text-zinc-400 pointer-coarse:text-base"
        />
      </label>
    </li>
  );
}

export function MemberChip({
  member,
  active,
  onClick,
  multi,
  disabled,
}: {
  member: { id: string; name: string; avatar: string };
  active: boolean;
  onClick: () => void;
  multi?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'flex h-10 items-center gap-1.5 rounded-full py-1 pr-3.5 pl-1 text-sm font-medium transition active:scale-95 disabled:opacity-30 disabled:active:scale-100',
        active
          ? 'bg-brand-500 text-white shadow-[0_4px_12px_-4px] shadow-brand-500/60'
          : 'bg-zinc-100/80 text-zinc-700 hover:bg-zinc-200/70 dark:bg-white/6 dark:text-zinc-200 dark:hover:bg-white/10',
        multi && !active && 'opacity-70',
      )}
    >
      <Avatar member={member} size="sm" className={active ? 'bg-white/90 text-zinc-800 dark:bg-white/90 dark:text-zinc-800' : undefined} />
      {member.name}
    </button>
  );
}

function TwoLines({ items, className, children }: { items: readonly string[]; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current!;
    let width = -1;
    const fit = () => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      const chips = [...el.children] as HTMLElement[];
      for (const c of chips) c.hidden = false;
      const second = [...new Set(chips.map((c) => c.offsetTop))].sort((a, b) => a - b)[1];
      for (const c of chips) c.hidden = second !== undefined && c.offsetTop > second;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [items]);
  return (
    <div ref={box} className={className}>
      {children}
    </div>
  );
}
