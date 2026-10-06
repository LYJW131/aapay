import { Check, ImageIcon, RotateCcw, Sparkles, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { computeBalances, suggestTransfers } from '../../../shared/settle.ts';
import { Avatar } from '../../components/Avatar.tsx';
import { Spinner } from '../../components/Spinner.tsx';
import { assistant as t } from '../../i18n/assistant.ts';
import { cn } from '../../lib/cn.ts';
import { useLedger } from '../ledger/context.tsx';
import { saveDefaultPayer, useDefaultPayer } from '../ledger/ExpenseForm.tsx';
import { ChangeSetView } from './ChangeCards.tsx';
import { Markdown } from './Markdown.tsx';
import { useChatState, useChatStore } from './state.ts';
import type { AssistantMessage, Step, UserMessage } from './store.ts';
import { ViewCard } from './Views.tsx';

export function AiAvatar({ busy, className }: { busy?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'relative flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-accent-400 text-white shadow-[0_4px_12px_-4px] shadow-brand-500/60',
        className,
      )}
      aria-hidden
    >
      {busy && <span className="ai-orbit absolute -inset-[3px] rounded-full" />}
      <Sparkles className="relative size-3.5" strokeWidth={2.4} />
    </span>
  );
}

export function Conversation({ onSuggest, onNavigate }: { onSuggest: (text: string) => void; onNavigate: () => void }) {
  const { messages } = useChatState();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const touched = useRef(0);
  const touch = () => {
    touched.current = Date.now();
  };

  useLayoutEffect(() => {
    const el = scroller.current!;
    el.scrollTop = el.scrollHeight;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);

  const last = messages.at(-1);
  useLayoutEffect(() => {
    if (last?.role === 'user') stick.current = true;
  }, [last]);

  return (
    <div
      ref={scroller}
      onWheel={touch}
      onTouchMove={touch}
      onPointerDown={touch}
      onKeyDown={touch}
      onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) stick.current = true;
        else if (Date.now() - touched.current < 600) stick.current = false;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <div ref={content} role="log" aria-live="polite" className="flow-root px-4 py-4">
        {messages.length === 0 ? (
          <EmptyState onSuggest={onSuggest} />
        ) : (
          <div className="space-y-5">
            {messages.map((m) => (m.role === 'user' ? <UserBubble key={m.id} message={m} /> : <AssistantBubble key={m.id} message={m} onNavigate={onNavigate} />))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ onSuggest }: { onSuggest: (text: string) => void }) {
  const { snapshot, key, memberById } = useLedger();
  const payer = useDefaultPayer(key('payer'));
  const needsMe = snapshot.members.length > 0 && !(payer && memberById.has(payer));
  const suggestions = useMemo(() => {
    const s = t.suggest;
    if (snapshot.members.length === 0) return [s.addMembers];
    const list: string[] = [];
    const balances = computeBalances(snapshot.members, snapshot.expenses, snapshot.settlements);
    if (suggestTransfers(balances).length > 0) list.push(s.settle);
    if (snapshot.expenses.some((e) => e.category === null)) list.push(s.tidy);
    list.push(s.log, s.byCategory, s.topPayer);
    return list.slice(0, 4);
  }, [snapshot]);

  return (
    <div className="flex min-h-full flex-col items-center px-1 pt-4 pb-2 text-center sm:pt-8">
      <motion.span
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 18 }}
        className="relative flex size-14 items-center justify-center"
      >
        <span className="ai-glow absolute inset-0 rounded-2xl opacity-60 blur-lg" aria-hidden />
        <span className="relative flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-accent-400 text-white shadow-lg">
          <Sparkles className="size-7" />
        </span>
      </motion.span>
      <h3 className="mt-4 text-lg font-semibold tracking-tight">{t.greeting}</h3>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{t.greetingSub}</p>

      {needsMe && <WhoAreYou hint={t.whoAreYouHint} className="mt-5 justify-center" />}

      <div className="mt-5 flex w-full flex-col gap-2">
        {suggestions.map((s, i) => (
          <motion.button
            key={s}
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30, delay: 0.08 + i * 0.05 }}
            onClick={() => onSuggest(s)}
            className="group flex min-h-11 items-center gap-2.5 rounded-2xl bg-zinc-900/3 px-3.5 py-2 text-left text-sm text-zinc-700 ring-1 ring-zinc-900/5 transition hover:bg-brand-500/8 hover:text-brand-700 hover:ring-brand-500/25 dark:bg-white/4 dark:text-zinc-200 dark:ring-white/6 dark:hover:bg-brand-400/10 dark:hover:text-brand-200"
          >
            <Sparkles className="size-3.5 shrink-0 text-brand-500 opacity-70 transition group-hover:opacity-100 dark:text-brand-300" />
            {s}
          </motion.button>
        ))}
      </div>
    </div>
  );
}

function WhoAreYou({ hint, className, onPick }: { hint: string; className?: string; onPick?: () => void }) {
  const { snapshot, key } = useLedger();
  return (
    <div className="w-full rounded-2xl bg-brand-500/6 p-3 ring-1 ring-brand-500/15 dark:bg-brand-400/8">
      <p className="mb-2 text-[13px] font-medium text-brand-700 dark:text-brand-200">
        {t.whoAreYou}
        <span className="ml-1.5 font-normal text-zinc-500 dark:text-zinc-400">{hint}</span>
      </p>
      <div className={cn('flex flex-wrap gap-1.5', className)}>
        {snapshot.members.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              saveDefaultPayer(key('payer'), m.id);
              onPick?.();
            }}
            className="flex h-9 items-center gap-1.5 rounded-full bg-surface pr-3.5 pl-1 text-sm font-medium shadow-sm ring-1 ring-zinc-900/8 transition hover:ring-brand-500/50 active:scale-95 dark:ring-white/10"
          >
            <Avatar member={m} size="xs" className="size-7" />
            {m.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function UserBubble({ message }: { message: UserMessage }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
      className="flex flex-col items-end gap-1.5 pl-10"
    >
      {message.imageCount > 0 &&
        (message.images?.length ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {message.images.map((src, i) => (
              <img key={i} src={src} alt="" className="size-16 rounded-2xl object-cover ring-1 ring-zinc-900/8 dark:ring-white/10" />
            ))}
          </div>
        ) : (
          <span className="flex items-center gap-1.5 rounded-full bg-zinc-900/5 px-2.5 py-1 text-xs text-zinc-500 dark:bg-white/6 dark:text-zinc-400">
            <ImageIcon className="size-3.5" />
            {t.imageCount(message.imageCount)}
          </span>
        ))}
      {message.text && (
        <div className="max-w-full rounded-[22px] rounded-br-md bg-gradient-to-br from-brand-500 to-brand-600 px-4 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-white shadow-[0_6px_16px_-8px] shadow-brand-500/60 dark:from-brand-500 dark:to-brand-700">
          {message.text}
        </div>
      )}
    </motion.div>
  );
}

function stepGroups(steps: Step[]) {
  const groups = new Map<string, { label: string; status: Step['status']; count: number }>();
  for (const s of steps) {
    const label = t.steps[s.tool] ?? t.stepFallback;
    const g = groups.get(label);
    if (!g) groups.set(label, { label, status: s.status, count: 1 });
    else {
      g.count++;
      if (s.status === 'start' || (s.status === 'error' && g.status !== 'start')) g.status = s.status;
    }
  }
  return [...groups.values()];
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {stepGroups(steps).map((g) => (
        <motion.li
          key={g.label}
          layout="position"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className={cn(
            'flex h-6 items-center gap-1 rounded-full pr-2.5 pl-1.5 text-xs font-medium',
            g.status === 'error'
              ? 'bg-rose-500/10 text-rose-600 dark:text-rose-300'
              : g.status === 'start'
                ? 'bg-brand-500/10 text-brand-700 dark:text-brand-200'
                : 'bg-zinc-900/5 text-zinc-500 dark:bg-white/6 dark:text-zinc-400',
          )}
        >
          {g.status === 'start' ? (
            <Spinner className="size-3" />
          ) : g.status === 'error' ? (
            <X className="size-3" strokeWidth={3} />
          ) : (
            <Check className="size-3 text-emerald-500" strokeWidth={3} />
          )}
          <span className={cn(g.status === 'start' && 'ai-shimmer-text')}>{g.label}</span>
          {g.count > 1 && <span className="tabular opacity-60">×{g.count}</span>}
        </motion.li>
      ))}
    </ul>
  );
}

function Thinking() {
  return (
    <span className="flex h-6 items-center gap-1" aria-label={t.stepFallback}>
      {[0, 1, 2].map((i) => (
        <span key={i} className="ai-dot size-1.5 rounded-full bg-brand-400" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </span>
  );
}

function AssistantBubble({ message, onNavigate }: { message: AssistantMessage; onNavigate: () => void }) {
  const store = useChatStore();
  const streaming = message.state === 'streaming';
  const lastText = message.parts.findLastIndex((p) => p.kind === 'text');
  const idle = streaming && message.parts.length === 0 && message.drafts.length === 0 && !message.changeSet && !message.steps.some((s) => s.status === 'start');

  return (
    <div className="flex gap-2.5">
      <AiAvatar busy={streaming} className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-2.5">
        {message.steps.length > 0 && <Steps steps={message.steps} />}
        {idle && <Thinking />}
        {message.parts.map((part, i) =>
          part.kind === 'text' ? (
            <div key={i} className="text-[15px] leading-relaxed text-zinc-800 dark:text-zinc-100">
              <Markdown text={part.text} caret={streaming && i === lastText && i === message.parts.length - 1} />
            </div>
          ) : (
            <ViewCard key={i} view={part.view} onNavigate={onNavigate} />
          ),
        )}
        {message.needsMe && <WhoAreYou hint={t.whoForImages} onPick={() => store.retry(message.id)} />}
        <ChangeSetView message={message} />
        {message.state === 'error' && (
          <div className="flex items-center gap-2 rounded-2xl bg-rose-500/8 py-1.5 pr-1.5 pl-3 text-sm text-rose-600 dark:text-rose-300">
            <span className="min-w-0 flex-1">{message.error ?? t.error}</span>
            <button
              type="button"
              onClick={() => store.retry(message.id)}
              className="flex h-8 items-center gap-1 rounded-xl px-2.5 text-[13px] font-medium transition hover:bg-rose-500/10"
            >
              <RotateCcw className="size-3.5" />
              {t.retry}
            </button>
          </div>
        )}
        {message.state === 'stopped' && <p className="text-xs text-zinc-400">{t.stopped}</p>}
      </div>
    </div>
  );
}
