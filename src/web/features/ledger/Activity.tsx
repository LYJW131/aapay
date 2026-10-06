import { Copy, History, RotateCw, ShieldAlert, ShieldCheck, Sparkles, UserRound, Users } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import { actorLabel, describeAudit, viaLabel } from '../../../shared/audit-text.ts';
import { keyFingerprint, parseAudit, type AuditActor, type AuditRecord } from '../../../shared/audit.ts';
import { Button } from '../../components/Button.tsx';
import { Empty } from '../../components/Card.tsx';
import { Reveal } from '../../components/Collapse.tsx';
import { Hint } from '../../components/Hint.tsx';
import { Spinner } from '../../components/Spinner.tsx';
import { ledger } from '../../i18n/ledger.ts';
import { locale } from '../../i18n/locale.ts';
import { formatDateTime, relativeTime } from '../../lib/dates.ts';
import { useDelayed } from '../../lib/hooks.ts';
import { cn } from '../../lib/cn.ts';
import type { AuditStatus } from './activity.ts';
import { useLedger } from './context.tsx';

const t = ledger.activity;

const ACTOR_ICON: Record<AuditActor['kind'], ReactNode> = {
  member: <UserRound />,
  admin: <ShieldCheck />,
  shared: <Users />,
  ai: <Sparkles />,
};

export function ActivityPanel() {
  const { activity } = useLedger();
  const state = useSyncExternalStore(activity.subscribe, activity.getState);
  const count = state.status.state === 'ok' ? state.status.count : null;

  useEffect(() => {
    if (count !== null) activity.markSeen(count);
  }, [activity, count]);

  const hasMore = (state.entries?.at(-1)?.seq ?? 1) > 1;

  return (
    <div className="space-y-3 pb-4">
      <VerifyStatus status={state.status} onRetry={() => void activity.sync()} />
      {state.entries === null ? (
        <Loading />
      ) : state.entries.length === 0 ? (
        <Empty icon={<History />} title={t.empty} hint={t.emptyHint} />
      ) : (
        <>
          <ul className="-mx-2">
            <AnimatePresence initial={false}>
              {state.entries.map((r) => (
                <Entry key={r.seq} record={r} />
              ))}
            </AnimatePresence>
          </ul>
          {hasMore && (
            <Button variant="ghost" className="w-full" loading={state.loadingMore} onClick={() => void activity.loadMore()}>
              {t.loadMore}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function Loading() {
  const shown = useDelayed(true);
  return <div className="flex h-40 items-center justify-center text-zinc-400">{shown && <Spinner className="size-6" />}</div>;
}

function VerifyStatus({ status, onRetry }: { status: AuditStatus; onRetry: () => void }) {
  const spinning = useDelayed(status.state === 'verifying');
  if (status.state === 'failed' || status.state === 'error') {
    const failed = status.state === 'failed';
    return (
      <div className="flex items-start gap-2.5 rounded-2xl bg-rose-500/10 px-3.5 py-3 text-[13px] text-rose-700 dark:text-rose-300">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{failed ? t.failedTitle(status.seq) : t.loadFailed}</p>
          <p className="mt-0.5 text-rose-600/80 dark:text-rose-300/80">
            {failed ? t.failedDetail(t.failures[status.reason]) : status.message}
          </p>
        </div>
        {!failed && (
          <button onClick={onRetry} className="-m-1 rounded-full p-1 hover:bg-rose-500/10" aria-label={t.retry}>
            <RotateCw className="size-4" />
          </button>
        )}
      </div>
    );
  }
  const ok = status.state === 'ok';
  return (
    <div className="flex items-start gap-2.5 rounded-2xl bg-emerald-500/8 px-3.5 py-3 text-[13px] dark:bg-emerald-400/8">
      {ok ? (
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-zinc-400">{spinning && <Spinner className="size-3.5" />}</span>
      )}
      <div className="min-w-0">
        <p className={cn('flex items-center gap-1.5 font-medium', ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-zinc-500')}>
          {ok ? t.verified(!!status.publicKey, status.count) : t.verifying}
          <Hint>{t.explain(!ok || !!status.publicKey)}</Hint>
        </p>
        {ok && status.publicKey && <KeyFingerprint publicKey={status.publicKey} />}
      </div>
    </div>
  );
}

function KeyFingerprint({ publicKey }: { publicKey: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(publicKey);
      toast.success(t.keyCopied);
    } catch {
      toast.error(t.copyFailed);
    }
  }
  return (
    <button
      onClick={copy}
      title={t.copyKey(publicKey)}
      className="mt-1 inline-flex items-center gap-1.5 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
    >
      {t.fingerprint} <span className="font-mono">{keyFingerprint(publicKey)}</span>
      <Copy className="size-3.5" />
    </button>
  );
}

function Entry({ record }: { record: AuditRecord }) {
  const { at, actor, action, via } = useMemo(() => parseAudit(record), [record]);
  const { summary, details } = describeAudit(action, locale);
  return (
    <Reveal as="li" layout="position">
      <div className="flex gap-3 rounded-2xl px-2 py-2.5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-500 dark:bg-white/6 dark:text-zinc-400 [&>svg]:size-4">
          {via === 'assistant' ? <Sparkles /> : ACTOR_ICON[actor.kind]}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug">{summary}</p>
          {details.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-zinc-400">
            {via && (
              <span title={viaLabel(via, locale)} className="shrink-0 rounded-full bg-brand-500/10 px-1.5 py-px font-medium text-brand-600 dark:text-brand-300">
                ✨ {ledger.page.assistant}
              </span>
            )}
            <span className="truncate">
              {actorLabel(actor, locale)} · <time title={formatDateTime(at)}>{relativeTime(at)}</time>
            </span>
          </p>
        </div>
      </div>
    </Reveal>
  );
}
