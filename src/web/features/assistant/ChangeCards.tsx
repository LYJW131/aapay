import { ArrowRight, Check, CornerDownLeft, Pencil, RefreshCw, RotateCcw, ScanLine, TriangleAlert, X } from 'lucide-react';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CATEGORY_EMOJI } from '../../../shared/categories.ts';
import type { Change } from '../../../shared/changes.ts';
import { centsToInput, formatMoney, parseAmount } from '../../../shared/money.ts';
import { LIMITS } from '../../../shared/limits.ts';
import type { ExpenseInput } from '../../../shared/schema.ts';
import type { Member } from '../../../shared/types.ts';
import { AutoHeight } from '../../components/AutoHeight.tsx';
import { Avatar } from '../../components/Avatar.tsx';
import { Button } from '../../components/Button.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { assistant as t } from '../../i18n/assistant.ts';
import { common } from '../../i18n/common.ts';
import { cn } from '../../lib/cn.ts';
import { useLedger } from '../ledger/context.tsx';
import { ExpenseForm } from '../ledger/ExpenseForm.tsx';
import { categoryText, changeTotal, dateText, expenseDiff, findDuplicate, membersWithPending, splitSummary, type FieldDiff } from './describe.ts';
import { useChatStore } from './state.ts';
import { changeKey, type AssistantMessage, type ChangeSet, type Draft } from './store.ts';

const SPRING = { type: 'spring', stiffness: 420, damping: 32 } as const;
const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform);

type Kind = 'create' | 'update' | 'delete';

const kindOf = (change: Change): Kind => (change.op.endsWith('.create') ? 'create' : change.op.endsWith('.update') ? 'update' : 'delete');

const BAR: Record<Kind, string> = {
  create: 'bg-emerald-500',
  update: 'bg-amber-400',
  delete: 'bg-rose-500',
};

const BADGE: Record<Kind, string> = {
  create: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  update: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  delete: 'bg-rose-500/12 text-rose-600 dark:text-rose-300',
};

export function ChangeSetView({ message }: { message: AssistantMessage }) {
  const set = message.changeSet;
  const live = !!set && set.changes.length > 0 && (set.status === 'pending' || set.status === 'applying' || set.status === 'conflict');
  const showGroup = live || message.drafts.length > 0;
  if (!set && !showGroup) return null;
  return (
    <LayoutGroup id={message.id}>
      <AutoHeight className="-m-1 p-1">
        {showGroup ? <Group message={message} set={live ? set : null} /> : set && <Summary messageId={message.id} set={set} />}
        {set && set.dropped.length > 0 && (
          <ul className="mt-2 space-y-1 px-1 text-xs text-zinc-500 dark:text-zinc-400">
            {set.dropped.map((d) => (
              <li key={d.id} className="flex items-start gap-1.5">
                <X className="mt-px size-3.5 shrink-0" />
                {t.dropped(d.reason)}
              </li>
            ))}
          </ul>
        )}
      </AutoHeight>
    </LayoutGroup>
  );
}

function Summary({ messageId, set }: { messageId: string; set: ChangeSet }) {
  const store = useChatStore();
  if (set.changes.length === 0) return null;
  const row = 'flex min-h-11 animate-fade-in items-center gap-2.5 rounded-2xl px-3.5 text-sm';
  switch (set.status) {
    case 'applied':
    case 'undoing':
      return (
        <div className={cn(row, 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300')}>
          <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500 text-white">
            <Check className="size-3.5" strokeWidth={3} />
          </span>
          <span className="flex-1 font-medium">{t.applied(set.applied ?? set.changes.length)}</span>
          {set.undo && set.undo.length > 0 && (
            <Button size="sm" variant="ghost" loading={set.status === 'undoing'} icon={<RotateCcw className="size-3.5" />} onClick={() => void store.undo(messageId)}>
              {common.undo}
            </Button>
          )}
        </div>
      );
    case 'undone':
      return (
        <div className={cn(row, 'bg-zinc-900/4 text-zinc-500 dark:bg-white/5 dark:text-zinc-400')}>
          <RotateCcw className="size-4" />
          {t.undone}
        </div>
      );
    case 'discarded':
      return <div className={cn(row, 'text-zinc-400 dark:text-zinc-500')}>{t.discarded}</div>;
    case 'superseded':
      return <div className={cn(row, 'text-zinc-400 dark:text-zinc-500')}>{t.superseded}</div>;
    default:
      return null;
  }
}

function Group({ message, set }: { message: AssistantMessage; set: ChangeSet | null }) {
  const store = useChatStore();
  const { snapshot } = useLedger();
  const reduce = useReducedMotion();
  const changes = set?.changes ?? [];
  const members = membersWithPending(snapshot, changes);
  const total = changeTotal(changes);
  const applying = set?.status === 'applying';
  const editable = set?.status === 'pending' || set?.status === 'conflict';
  const fresh = set?.fresh ?? [];

  return (
    <section className="overflow-hidden rounded-3xl bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-16px_rgb(0_0_0/0.18)] ring-1 ring-zinc-900/6 dark:bg-white/4 dark:shadow-none dark:ring-white/10">
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-2 text-[13px]">
        <span className="font-semibold text-zinc-800 dark:text-zinc-100">{set ? t.pendingTitle : t.recognizing}</span>
        <span className="text-zinc-400">·</span>
        <span className="tabular text-zinc-500 dark:text-zinc-400">{t.items(changes.length + message.drafts.length)}</span>
        {total > 0 && <span className="text-zinc-400">·</span>}
        {total > 0 && <span className="tabular font-medium text-zinc-700 dark:text-zinc-200">{t.total(formatMoney(total))}</span>}
      </header>
      <ul className="space-y-2 px-2.5 pb-2.5">
        <AnimatePresence initial={false}>
          {changes.map((change) => {
            const k = changeKey(change);
            const order = fresh.indexOf(k);
            const draftKey = set?.morph[k];
            return (
              <motion.li
                key={k}
                layout="position"
                layoutId={draftKey ? `draft-${draftKey}` : undefined}
                initial={draftKey ? false : { opacity: 0, y: 14, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
                transition={{ ...SPRING, delay: reduce || order < 0 ? 0 : order * 0.06 }}
              >
                <ChangeCard messageId={message.id} change={change} members={members} editable={editable} />
              </motion.li>
            );
          })}
          {message.drafts.map((draft) => (
            <motion.li
              key={`draft-${draft.key}`}
              layoutId={`draft-${draft.key}`}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
              transition={SPRING}
            >
              <DraftCard draft={draft} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {set?.status === 'conflict' && (
        <div className="mx-2.5 mb-2.5 flex flex-wrap items-center gap-2 rounded-2xl bg-amber-500/12 py-2 pr-2 pl-3.5 text-sm text-amber-800 dark:text-amber-200">
          <TriangleAlert className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            {t.conflict}
            {set.error && <span className="block text-xs opacity-75">{set.error}</span>}
          </span>
          <Button size="sm" variant="secondary" icon={<RefreshCw className="size-3.5" />} onClick={() => store.recheck()}>
            {t.recheck}
          </Button>
        </div>
      )}
      {set && (
        <footer className="flex items-center justify-end gap-2 border-t border-zinc-900/5 px-2.5 py-2.5 dark:border-white/6">
          <Button size="sm" variant="ghost" disabled={applying} onClick={() => store.discard()}>
            {t.discardAll}
          </Button>
          <Button size="sm" variant="primary" loading={applying} icon={<Check className="size-3.5" />} onClick={() => void store.apply()}>
            {t.confirm}
            <kbd className="ml-0.5 hidden items-center gap-0.5 rounded-md bg-white/20 px-1 font-sans text-[11px] lg:inline-flex">
              {isMac ? '⌘' : 'Ctrl'}
              <CornerDownLeft className="size-3" />
            </kbd>
          </Button>
        </footer>
      )}
    </section>
  );
}

function CardFrame({
  kind,
  label,
  children,
  actions,
  className,
}: {
  kind: Kind;
  label: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-2xl bg-zinc-50 py-3 pr-3 pl-4 ring-1 ring-zinc-900/4 dark:bg-white/4 dark:ring-white/6',
        kind === 'delete' && 'bg-rose-500/6 dark:bg-rose-500/8',
        className,
      )}
    >
      <span className={cn('absolute inset-y-2 left-1.5 w-1 rounded-full', BAR[kind])} aria-hidden />
      <div className="mb-1.5 flex items-center gap-2">
        <span className={cn('rounded-md px-1.5 py-px text-[11px] font-semibold', BADGE[kind])}>{t.kind[kind]}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-400">{label}</span>
        {actions && <span className="-my-1 -mr-1 flex shrink-0 items-center">{actions}</span>}
      </div>
      {children}
    </div>
  );
}

function IconButton({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-900/6 hover:text-zinc-700 disabled:opacity-30 dark:hover:bg-white/10 dark:hover:text-zinc-200"
    >
      {children}
    </button>
  );
}

function ChangeCard({ messageId, change, members, editable }: { messageId: string; change: Change; members: Member[]; editable: boolean }) {
  const store = useChatStore();
  const { snapshot } = useLedger();
  const [editing, setEditing] = useState(false);
  const kind = kindOf(change);
  const byId = new Map(members.map((m) => [m.id, m]));
  const name = (id: string) => byId.get(id)?.name ?? t.someone;
  const remove = () => store.removeChange(messageId, changeKey(change));
  const known = (ids: string[]) => ids.every((id) => snapshot.members.some((m) => m.id === id));
  const canEditInSheet =
    (change.op === 'expense.create' || change.op === 'expense.update') &&
    known([change.expense.payerId, ...(change.expense.split.mode === 'even' ? change.expense.split.memberIds : change.expense.split.shares.map((s) => s.memberId))]);
  const inline = change.op === 'member.create' || change.op === 'member.update' || change.op === 'settlement.create';

  const actions = editable && (
    <>
      {(canEditInSheet || inline) && (
        <IconButton label={t.edit} onClick={() => setEditing(true)} disabled={editing}>
          <Pencil className="size-3.5" />
        </IconButton>
      )}
      <IconButton label={t.remove} onClick={remove}>
        <X className="size-4" />
      </IconButton>
    </>
  );

  switch (change.op) {
    case 'expense.create': {
      const duplicate = findDuplicate(change.expense, snapshot.expenses);
      return (
        <>
          <CardFrame kind={kind} label={splitSummary(change.expense)} actions={actions}>
            <ExpenseRow input={change.expense} name={name} member={byId.get(change.expense.payerId)} />
            {duplicate && (
              <p className="mt-2 flex items-center gap-1.5 rounded-xl bg-amber-500/12 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-200">
                <TriangleAlert className="size-3.5 shrink-0" />
                <span className="font-medium">{t.duplicate}</span>
                <span className="min-w-0 truncate opacity-80">{t.duplicateHint(duplicate.title, dateText(duplicate.date))}</span>
              </p>
            )}
          </CardFrame>
          <ExpenseSheet
            open={editing}
            input={change.expense}
            onClose={() => setEditing(false)}
            onSave={(expense) => store.editChange(messageId, { ...change, expense })}
          />
        </>
      );
    }
    case 'expense.update': {
      const before = snapshot.expenses.find((e) => e.id === change.id);
      const diffs = before ? expenseDiff(before, change.expense, members, name) : [];
      return (
        <>
          <CardFrame kind={kind} label={before ? `${CATEGORY_EMOJI[before.category ?? 'other']} ${before.title}` : t.missing} actions={actions}>
            {before ? <DiffList diffs={diffs} /> : <ExpenseRow input={change.expense} name={name} member={byId.get(change.expense.payerId)} />}
          </CardFrame>
          <ExpenseSheet
            open={editing}
            input={change.expense}
            onClose={() => setEditing(false)}
            onSave={(expense) => store.editChange(messageId, { ...change, expense })}
          />
        </>
      );
    }
    case 'expense.delete': {
      const before = snapshot.expenses.find((e) => e.id === change.id);
      return (
        <CardFrame kind={kind} label={before ? splitSummary({ amount: before.amount, split: { mode: 'exact', shares: before.shares } }) : t.missing} actions={actions}>
          {before && (
            <div className="line-through decoration-rose-500/60 opacity-70">
              <ExpenseRow
                input={{ ...before, split: { mode: 'exact', shares: before.shares } }}
                name={name}
                member={byId.get(before.payerId)}
              />
            </div>
          )}
        </CardFrame>
      );
    }
    case 'member.create':
    case 'member.update': {
      const before = change.op === 'member.update' ? snapshot.members.find((m) => m.id === change.id) : undefined;
      const member = { id: change.id, name: change.member.name, avatar: change.member.avatar ?? before?.avatar ?? '' };
      return (
        <CardFrame kind={kind} label={t.member} actions={actions}>
          {editing ? (
            <InlineEdit
              initial={change.member.name}
              maxLength={LIMITS.memberName}
              validate={(v) => (v.trim() ? null : t.nameRequired)}
              onCancel={() => setEditing(false)}
              onSave={(v) => {
                store.editChange(messageId, { ...change, member: { ...change.member, name: v.trim() } });
                setEditing(false);
              }}
            />
          ) : (
            <div className="flex items-center gap-2.5">
              <Avatar member={member} size="sm" />
              {before && before.name !== change.member.name && (
                <>
                  <span className="text-sm text-zinc-400 line-through">{before.name}</span>
                  <ArrowRight className="size-3.5 text-zinc-400" />
                </>
              )}
              <span className="text-[15px] font-semibold">{change.member.name}</span>
            </div>
          )}
        </CardFrame>
      );
    }
    case 'member.delete': {
      const before = snapshot.members.find((m) => m.id === change.id);
      return (
        <CardFrame kind={kind} label={t.member} actions={actions}>
          <div className="flex items-center gap-2.5 opacity-70">
            <Avatar member={before} size="sm" />
            <span className="text-[15px] font-semibold line-through decoration-rose-500/60">{before?.name ?? t.missing}</span>
          </div>
        </CardFrame>
      );
    }
    case 'settlement.create':
      return (
        <CardFrame kind={kind} label={`${t.settlement} · ${dateText(change.settlement.date)}`} actions={actions}>
          {editing ? (
            <InlineEdit
              initial={centsToInput(change.settlement.amount)}
              inputMode="decimal"
              validate={(v) => (parseAmount(v) ? null : t.amountInvalid)}
              onCancel={() => setEditing(false)}
              onSave={(v) => {
                store.editChange(messageId, { ...change, settlement: { ...change.settlement, amount: parseAmount(v)! } });
                setEditing(false);
              }}
            />
          ) : (
            <TransferRow from={byId.get(change.settlement.fromId)} to={byId.get(change.settlement.toId)} amount={change.settlement.amount} name={name} />
          )}
        </CardFrame>
      );
    case 'settlement.delete': {
      const before = snapshot.settlements.find((s) => s.id === change.id);
      return (
        <CardFrame kind={kind} label={before ? `${t.settlement} · ${dateText(before.date)}` : t.missing} actions={actions}>
          {before && (
            <div className="line-through decoration-rose-500/60 opacity-70">
              <TransferRow from={byId.get(before.fromId)} to={byId.get(before.toId)} amount={before.amount} name={name} />
            </div>
          )}
        </CardFrame>
      );
    }
  }
}

function ExpenseRow({ input, name, member }: { input: ExpenseInput; name: (id: string) => string; member: Member | undefined }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-white text-xl shadow-sm ring-1 ring-zinc-900/5 dark:bg-white/8 dark:ring-white/8">
        {input.category ? CATEGORY_EMOJI[input.category] : '🧾'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold">{input.title}</p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          <Avatar member={member} size="xs" className="size-4 text-[11px]" />
          <span className="truncate">{t.paidBy(name(input.payerId))}</span>
          <span className="text-zinc-300 dark:text-zinc-600">·</span>
          <span className="shrink-0">{dateText(input.date)}</span>
          {input.category && <span className="hidden truncate sm:inline">· {categoryText(input.category)}</span>}
        </p>
      </div>
      <span className="tabular shrink-0 text-lg font-semibold tracking-tight">{formatMoney(input.amount)}</span>
    </div>
  );
}

function TransferRow({ from, to, amount, name }: { from: Member | undefined; to: Member | undefined; amount: number; name: (id: string) => string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex shrink-0 -space-x-2">
        <Avatar member={from} size="sm" className="ring-2 ring-zinc-50 dark:ring-zinc-800" />
        <Avatar member={to} size="sm" className="ring-2 ring-zinc-50 dark:ring-zinc-800" />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1 text-sm">
        <span className="truncate">{from?.name ?? name('')}</span>
        <ArrowRight className="size-3.5 shrink-0 text-zinc-400" />
        <span className="truncate">{to?.name ?? name('')}</span>
      </span>
      <span className="tabular shrink-0 text-lg font-semibold tracking-tight text-emerald-600 dark:text-emerald-400">{formatMoney(amount)}</span>
    </div>
  );
}

function DiffList({ diffs }: { diffs: FieldDiff[] }) {
  return (
    <dl className="space-y-1">
      {diffs.map((d) => (
        <div key={d.label} className="flex items-baseline gap-2 text-sm">
          <dt className="w-12 shrink-0 text-xs text-zinc-400">{d.label}</dt>
          <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span className="text-zinc-400 line-through">{d.before}</span>
            <ArrowRight className="size-3 shrink-0 self-center text-zinc-400" />
            <span className="font-semibold">{d.after}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function InlineEdit({
  initial,
  inputMode,
  maxLength,
  validate,
  onSave,
  onCancel,
}: {
  initial: string;
  inputMode?: 'decimal';
  maxLength?: number;
  validate: (value: string) => string | null;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const error = validate(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error) onSave(value);
      }}
    >
      <input
        ref={input}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
        inputMode={inputMode}
        maxLength={maxLength}
        aria-invalid={!!error}
        className="field tabular h-9 min-w-0 flex-1 rounded-xl px-3 aria-invalid:ring-rose-500/50"
      />
      <Button size="sm" variant="ghost" onClick={onCancel}>
        {t.cancel}
      </Button>
      <Button size="sm" variant="soft" type="submit" disabled={!!error}>
        {t.save}
      </Button>
    </form>
  );
}

function ExpenseSheet({ open, input, onClose, onSave }: { open: boolean; input: ExpenseInput; onClose: () => void; onSave: (input: ExpenseInput) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={t.editTitle}>
      {open && <ExpenseForm initial={input} onSave={onSave} onDone={onClose} />}
    </Sheet>
  );
}

function Typewriter({ text }: { text: string }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? text.length : 0);
  useEffect(() => {
    if (reduce) return setShown(text.length);
    if (shown >= text.length) return;
    const id = setTimeout(() => setShown((n) => Math.min(text.length, n + 1)), 28);
    return () => clearTimeout(id);
  }, [shown, text, reduce]);
  return <>{text.slice(0, shown)}</>;
}

function DraftCard({ draft }: { draft: Draft }) {
  const { title, amount, date, category } = draft.fields;
  const cents = amount === undefined ? null : Math.round(amount * 100);
  return (
    <div className="relative overflow-hidden rounded-2xl bg-zinc-50 py-3 pr-3 pl-4 ring-1 ring-zinc-900/4 dark:bg-white/4 dark:ring-white/6">
      <span className="ai-shimmer pointer-events-none absolute inset-0" aria-hidden />
      <span className="absolute inset-y-2 left-1.5 w-1 rounded-full bg-gradient-to-b from-brand-400 to-accent-400" aria-hidden />
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-brand-600 dark:text-brand-300">
        <ScanLine className="size-3.5" />
        {t.recognizing}
      </div>
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-white text-xl shadow-sm ring-1 ring-zinc-900/5 dark:bg-white/8 dark:ring-white/8">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={category ?? 'none'} initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={SPRING}>
              {category ? CATEGORY_EMOJI[category] : <span className="block size-5 rounded-lg bg-zinc-200 dark:bg-white/10" />}
            </motion.span>
          </AnimatePresence>
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          {title ? (
            <p className="truncate text-[15px] font-semibold">
              <Typewriter text={title} />
            </p>
          ) : (
            <span className="block h-4 w-2/3 rounded-md bg-zinc-200 dark:bg-white/10" />
          )}
          {date ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{dateText(date)}</p>
          ) : (
            <span className="block h-3 w-1/3 rounded-md bg-zinc-200/80 dark:bg-white/8" />
          )}
        </div>
        {cents !== null ? (
          <motion.span
            key={cents}
            initial={{ scale: 1.25, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 500, damping: 18 }}
            className="tabular shrink-0 text-lg font-semibold tracking-tight"
          >
            {formatMoney(cents)}
          </motion.span>
        ) : (
          <span className="block h-5 w-16 shrink-0 rounded-md bg-zinc-200 dark:bg-white/10" />
        )}
      </div>
    </div>
  );
}
