import { Plus, ShieldAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { formatMoney } from '../../../shared/money.ts';
import type { AdminIdentity, LiveMessage, PublicConfig, SessionInfo, Snapshot } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { Card } from '../../components/Card.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { Spinner } from '../../components/Spinner.tsx';
import { common } from '../../i18n/common.ts';
import { ledger } from '../../i18n/ledger.ts';
import { useMediaQuery, useMinuteTick, usePersistentState } from '../../lib/hooks.ts';
import { load } from '../../lib/storage.ts';
import { adminModules } from '../admin/preload.ts';
import { AboutCard } from './About.tsx';
import { ActivityLog } from './activity.ts';
import { LedgerContext, type LedgerContextValue } from './context.tsx';
import { ExpenseForm } from './ExpenseForm.tsx';
import { Header } from './Header.tsx';
import { MembersCard } from './Members.tsx';
import { OverviewCard } from './Overview.tsx';
import { inRange, involves, resolveRange, type RangeFilter } from './range.ts';
import { SettlementCard } from './Settlement.tsx';
import { LedgerStore } from './store.ts';
import { Timeline } from './Timeline.tsx';
import { WelcomeSheet } from './Welcome.tsx';

const LazyAdminCard = lazy(() => import('../admin/AdminCard.tsx').then((m) => ({ default: m.AdminCard })));

const t = ledger.page;

function describe({ event }: LiveMessage, before: Snapshot, after: Snapshot): string | null {
  const name = (id: string) => after.members.find((m) => m.id === id)?.name ?? before.members.find((m) => m.id === id)?.name ?? t.someone;
  switch (event.type) {
    case 'expense.saved': {
      const existed = before.expenses.some((e) => e.id === event.expense.id);
      const { title, amount, payerId } = event.expense;
      return existed ? t.expenseEdited(title) : t.expenseAdded(name(payerId), title, formatMoney(amount));
    }
    case 'expense.deleted': {
      const e = before.expenses.find((x) => x.id === event.id);
      return e ? t.expenseDeleted(e.title, formatMoney(e.amount)) : null;
    }
    case 'settlement.saved':
      return t.settlementAdded(name(event.settlement.fromId), name(event.settlement.toId), formatMoney(event.settlement.amount));
    case 'settlement.deleted':
      return t.settlementDeleted;
    case 'member.saved':
      return before.members.some((m) => m.id === event.member.id) ? null : t.memberJoined(event.member.name);
    case 'member.deleted':
      return t.memberRemoved(name(event.id));
    default:
      return null;
  }
}

function summarize(messages: LiveMessage[], before: Snapshot): string | null {
  const existed = (id: string) => before.expenses.some((e) => e.id === id);
  const added = new Map<string, number>();
  const edited = new Set<string>();
  const deleted = new Set<string>();
  let settlementsAdded = 0;
  let settlementsDeleted = 0;
  let membersAdded = 0;
  let membersRemoved = 0;
  for (const { event } of messages) {
    switch (event.type) {
      case 'expense.saved':
        if (existed(event.expense.id)) edited.add(event.expense.id);
        else added.set(event.expense.id, event.expense.amount);
        break;
      case 'expense.deleted':
        if (added.delete(event.id)) break;
        edited.delete(event.id);
        deleted.add(event.id);
        break;
      case 'settlement.saved':
        settlementsAdded++;
        break;
      case 'settlement.deleted':
        settlementsDeleted++;
        break;
      case 'member.saved':
        if (!before.members.some((m) => m.id === event.member.id)) membersAdded++;
        break;
      case 'member.deleted':
        membersRemoved++;
        break;
    }
  }
  const b = t.batch;
  const total = [...added.values()].reduce((sum, a) => sum + a, 0);
  const parts = [
    added.size > 0 && b.expensesAdded(added.size, formatMoney(total)),
    edited.size > 0 && b.expensesEdited(edited.size),
    deleted.size > 0 && b.expensesDeleted(deleted.size),
    settlementsAdded > 0 && b.settlementsAdded(settlementsAdded),
    settlementsDeleted > 0 && b.settlementsDeleted(settlementsDeleted),
    membersAdded > 0 && b.membersAdded(membersAdded),
    membersRemoved > 0 && b.membersRemoved(membersRemoved),
  ].filter((p) => p !== false);
  return parts.length ? b.join(parts) : null;
}

// 同一批变更的远程消息逐条到达，凑齐后只弹一次；漏收时由定时器兜底
function remoteNotifier(current: () => Snapshot | null) {
  const pending = new Map<string, { before: Snapshot; messages: LiveMessage[]; timer: ReturnType<typeof setTimeout> }>();
  const show = (messages: LiveMessage[], before: Snapshot) => {
    const after = current();
    const [first] = messages;
    if (!after || !first) return;
    const text = messages.length === 1 ? describe(first, before, after) : summarize(messages, before);
    if (!text) return;
    const source = first.via === 'assistant' ? t.assistant : first.origin?.startsWith('mcp:') ? first.origin.slice(4) : null;
    toast(source ? `${source} · ${text}` : text, { icon: source ? '✨' : '🔔' });
  };
  const flush = (id: string) => {
    const group = pending.get(id);
    if (!group) return;
    clearTimeout(group.timer);
    pending.delete(id);
    show(group.messages, group.before);
  };
  return (message: LiveMessage, before: Snapshot) => {
    const { batch } = message;
    if (!batch || batch.size <= 1) return show([message], before);
    let group = pending.get(batch.id);
    if (!group) {
      group = { before, messages: [], timer: setTimeout(() => flush(batch.id), 800) };
      pending.set(batch.id, group);
    }
    group.messages.push(message);
    if (group.messages.length >= batch.size) flush(batch.id);
  };
}

export function LedgerPage({
  session,
  initialSnapshot,
  welcome,
  config,
  admin,
  adminExpired,
  onSwitch,
  onExit,
}: {
  session: SessionInfo;
  initialSnapshot: Snapshot;
  welcome: boolean;
  config: PublicConfig;
  admin: AdminIdentity | null;
  adminExpired: boolean;
  onSwitch: (session: SessionInfo) => Promise<void>;
  onExit: (message?: string) => void;
}) {
  const prefix = `aapay:${session.ledger.id}:`;
  const [activity] = useState(() => new ActivityLog(prefix));
  const [notifyRemote] = useState(() => remoteNotifier(() => store.getState().snapshot));
  const [store] = useState(
    () =>
      new LedgerStore({
        onAudit: (record, own) => activity.receive(record, own),
        onClosed: (reason) =>
          onExit(reason === 'unauthorized' && session.role === 'admin' ? common.adminExpired : t.closed[reason]),
        onRemote: (message, before) => notifyRemote(message, before),
      }, initialSnapshot),
  );
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const AdminCard = adminModules()?.AdminCard ?? LazyAdminCard;
  const desktop = useMediaQuery('(min-width: 1024px)');
  const [composerOpen, setComposerOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(() => {
    const payer = load<string | null>(`${prefix}payer`, null);
    return welcome && !initialSnapshot.members.some((m) => m.id === payer);
  });
  useMinuteTick();

  useEffect(() => {
    store.start();
    const prefetch = setTimeout(() => void activity.sync(), 800);
    return () => {
      clearTimeout(prefetch);
      store.stop();
    };
  }, [store, activity]);

  const [range, setRange] = usePersistentState<RangeFilter>(`${prefix}range`, { key: 'all' });
  const [memberId, setMemberId] = usePersistentState<string | null>(`${prefix}member`, null);

  const snapshot = state.snapshot;
  const context = useMemo<LedgerContextValue | null>(
    () =>
      snapshot && {
        snapshot,
        session,
        store,
        activity,
        memberById: new Map(snapshot.members.map((m) => [m.id, m])),
        key: (name) => prefix + name,
        recognize: config.recognize,
      },
    [snapshot, session, store, activity, prefix, config.recognize],
  );

  const filtered = useMemo(() => {
    if (!snapshot) return { expenses: [], settlements: [], memberId: null };
    const bounds = resolveRange(range);
    const validMember = memberId && snapshot.members.some((m) => m.id === memberId) ? memberId : null;
    const keep = (r: Snapshot['expenses'][number] | Snapshot['settlements'][number]) =>
      inRange(r.date, bounds) && (!validMember || involves(r, validMember));
    return { expenses: snapshot.expenses.filter(keep), settlements: snapshot.settlements.filter(keep), memberId: validMember };
  }, [snapshot, range, memberId]);

  useEffect(() => {
    if (snapshot) document.title = `${snapshot.ledger.emoji} ${snapshot.ledger.name} · AAPay`;
  }, [snapshot?.ledger.name, snapshot?.ledger.emoji]);

  if (!context) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 text-zinc-400">
        <Spinner className="size-7" />
        {state.error && (
          <p className="text-sm">
            {state.error} · <button className="underline" onClick={() => void store.refresh()}>{t.retry}</button>
          </p>
        )}
      </div>
    );
  }

  return (
    <LedgerContext value={context}>
      <Header live={state.live} config={config} admin={!!admin} onSwitch={onSwitch} onLeave={() => onExit()} />
      <main className="mx-auto max-w-6xl px-4 pt-4 pb-32 lg:grid lg:grid-cols-[400px_minmax(0,1fr)] lg:items-start lg:gap-5 lg:pt-6 lg:pb-12">
        {admin && (
          <div className="mb-4 lg:col-span-2 lg:mb-0">
            <Suspense fallback={null}>
              <AdminCard admin={admin} current={session} onEnter={onSwitch} />
            </Suspense>
          </div>
        )}
        {!admin && adminExpired && (
          <div className="card mb-4 flex items-center gap-3 px-5 py-4 lg:col-span-2 lg:mb-0">
            <ShieldAlert className="size-[18px] shrink-0 text-amber-500" />
            <span className="flex-1 text-sm">{t.adminExpired}</span>
            <Button size="sm" variant="soft" onClick={() => window.location.assign('/admin')}>
              {t.signInAgain}
            </Button>
          </div>
        )}
        <aside className="space-y-4">
          {desktop && (
            <Card id="compose" title={t.addExpense} icon={<Plus />}>
              <ExpenseForm />
            </Card>
          )}
          <MembersCard />
          {desktop && <AboutCard />}
        </aside>
        <div className="mt-4 space-y-4 lg:mt-0">
          <OverviewCard
            range={range}
            onRange={setRange}
            memberId={filtered.memberId}
            onMember={setMemberId}
            expenses={filtered.expenses}
          />
          <SettlementCard />
          <Timeline expenses={filtered.expenses} settlements={filtered.settlements} range={range} />
          {!desktop && <AboutCard />}
        </div>
      </main>

      <AnimatePresence>
        {!desktop && snapshot!.members.length > 0 && (
          <motion.button
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            whileTap={{ scale: 0.92 }}
            onClick={() => setComposerOpen(true)}
            className="fixed right-5 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-20 flex h-14 items-center gap-2 rounded-full bg-gradient-to-br from-brand-500 to-accent-500 pr-6 pl-5 font-semibold text-white shadow-[0_12px_32px_-8px] shadow-brand-500/70"
          >
            <Plus className="size-5" strokeWidth={2.5} />
            {t.addExpense}
          </motion.button>
        )}
      </AnimatePresence>
      <WelcomeSheet open={welcomeOpen} onClose={() => setWelcomeOpen(false)} />
      {!desktop && (
        <Sheet open={composerOpen} onClose={() => setComposerOpen(false)} title={t.addExpense}>
          <ExpenseForm onDone={() => setComposerOpen(false)} />
        </Sheet>
      )}
    </LedgerContext>
  );
}
