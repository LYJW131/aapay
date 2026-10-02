import { Plus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { formatMoney } from '../../../shared/money.ts';
import type { AdminIdentity, LiveMessage, PublicConfig, SessionInfo, Snapshot } from '../../../shared/types.ts';
import { Card } from '../../components/Card.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { Spinner } from '../../components/Spinner.tsx';
import { useMediaQuery, useMinuteTick, usePersistentState } from '../../lib/hooks.ts';
import { LedgerContext, type LedgerContextValue } from './context.tsx';
import { ExpenseForm } from './ExpenseForm.tsx';
import { Header } from './Header.tsx';
import { MembersCard } from './Members.tsx';
import { OverviewCard } from './Overview.tsx';
import { inRange, involves, resolveRange, type RangeFilter } from './range.ts';
import { SettlementCard } from './Settlement.tsx';
import { LedgerStore, type CloseReason } from './store.ts';
import { Timeline } from './Timeline.tsx';

// 只有管理员会用到，按需加载
const AdminCard = lazy(() => import('../admin/AdminCard.tsx').then((m) => ({ default: m.AdminCard })));

const CLOSE_MESSAGES: Record<CloseReason, string> = {
  deleted: '这个账本已被管理员删除',
  revoked: '分享口令已被撤销，请向管理员索取新口令',
  unauthorized: '登录已过期，请重新输入口令',
};

/** 把其他人的操作描述成一句通知 */
function describe({ event }: LiveMessage, before: Snapshot, after: Snapshot): string | null {
  const name = (id: string) => after.members.find((m) => m.id === id)?.name ?? before.members.find((m) => m.id === id)?.name ?? '某人';
  switch (event.type) {
    case 'expense.saved': {
      const existed = before.expenses.some((e) => e.id === event.expense.id);
      const { title, amount, payerId } = event.expense;
      return existed ? `修改了「${title}」` : `${name(payerId)} 付了 ${title} ${formatMoney(amount)}`;
    }
    case 'expense.deleted': {
      const e = before.expenses.find((x) => x.id === event.id);
      return e ? `删除了「${e.title}」${formatMoney(e.amount)}` : null;
    }
    case 'settlement.saved':
      return `${name(event.settlement.fromId)} 向 ${name(event.settlement.toId)} 还款 ${formatMoney(event.settlement.amount)}`;
    case 'settlement.deleted':
      return '删除了一笔还款记录';
    case 'member.saved':
      return before.members.some((m) => m.id === event.member.id) ? null : `新成员 ${event.member.name} 加入`;
    case 'member.deleted':
      return `移除了成员 ${name(event.id)}`;
    default:
      return null;
  }
}

export function LedgerPage({
  session,
  config,
  admin,
  onSwitch,
  onExit,
}: {
  session: SessionInfo;
  config: PublicConfig;
  /** 已登录的管理员会在页面顶部看到管理卡片 */
  admin: AdminIdentity | null;
  onSwitch: (session: SessionInfo) => void;
  onExit: (message?: string) => void;
}) {
  const [store] = useState(
    () =>
      new LedgerStore({
        onClosed: (reason) => onExit(CLOSE_MESSAGES[reason]),
        onRemote: (message, before) => {
          const after = store.getState().snapshot;
          const text = after && describe(message, before, after);
          const via = message.origin?.startsWith('mcp:') ? message.origin.slice(4) : null;
          if (text) toast(via ? `${via} · ${text}` : text, { icon: via ? '✨' : '🔔' });
        },
      }),
  );
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const desktop = useMediaQuery('(min-width: 1024px)');
  const [composerOpen, setComposerOpen] = useState(false);
  useMinuteTick();

  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  const prefix = `aapay:${session.ledger.id}:`;
  const [range, setRange] = usePersistentState<RangeFilter>(`${prefix}range`, { key: 'all' });
  const [memberId, setMemberId] = usePersistentState<string | null>(`${prefix}member`, null);

  const snapshot = state.snapshot;
  const context = useMemo<LedgerContextValue | null>(
    () =>
      snapshot && {
        snapshot,
        session,
        store,
        memberById: new Map(snapshot.members.map((m) => [m.id, m])),
        key: (name) => prefix + name,
      },
    [snapshot, session, store, prefix],
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
    if (snapshot) document.title = `${snapshot.ledger.name} · AAPay`;
  }, [snapshot?.ledger.name]);

  if (!context) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 text-zinc-400">
        <Spinner className="size-7" />
        {state.error && (
          <p className="text-sm">
            {state.error} · <button className="underline" onClick={() => void store.refresh()}>重试</button>
          </p>
        )}
      </div>
    );
  }

  return (
    <LedgerContext value={context}>
      <Header live={state.live} config={config} admin={!!admin} onLeave={() => onExit()} />
      <main className="mx-auto max-w-6xl px-4 pt-4 pb-32 lg:grid lg:grid-cols-[400px_minmax(0,1fr)] lg:items-start lg:gap-5 lg:pt-6 lg:pb-12">
        {admin && (
          <Suspense fallback={null}>
            <div className="mb-4 lg:col-span-2 lg:mb-0">
              <AdminCard admin={admin} current={session} onEnter={onSwitch} />
            </div>
          </Suspense>
        )}
        <aside className="space-y-4 lg:sticky lg:top-20">
          {desktop && (
            <Card title="记一笔" icon={<Plus />}>
              <ExpenseForm />
            </Card>
          )}
          <MembersCard />
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
            记一笔
          </motion.button>
        )}
      </AnimatePresence>
      {!desktop && (
        <Sheet open={composerOpen} onClose={() => setComposerOpen(false)} title="记一笔">
          <ExpenseForm onDone={() => setComposerOpen(false)} />
        </Sheet>
      )}
    </LedgerContext>
  );
}
