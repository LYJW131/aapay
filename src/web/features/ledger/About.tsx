import { ExternalLink, Info, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../components/Button.tsx';
import { Card } from '../../components/Card.tsx';
import { Hint } from '../../components/Hint.tsx';
import { ledger } from '../../i18n/ledger.ts';
import { LOCALE_KEY } from '../../i18n/locale.ts';
import { formatDateTime } from '../../lib/dates.ts';
import { clearAll } from '../../lib/storage.ts';
import { BUILD, REPO_URL, useDeployedUpdate } from '../../lib/version.ts';

const t = ledger.about;

const RUNTIME = { cloudflare: 'Cloudflare Workers', node: 'Docker / Node' } as const;

const link = 'inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-300';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-2.5 text-sm">
      <dt className="w-20 shrink-0 text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

export function AboutCard() {
  const update = useDeployedUpdate();
  const reload = () => window.location.reload();

  return (
    <Card
      id="about"
      defaultCollapsed
      title={t.title}
      icon={<Info />}
      action={
        update && (
          <button onClick={reload} className="rounded-full bg-brand-500/12 px-2 py-0.5 text-xs font-medium text-brand-600 dark:text-brand-300">
            {t.updateBadge}
          </button>
        )
      }
    >
      {update && (
        <div className="mb-2 flex items-center gap-3 rounded-2xl bg-brand-500/8 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t.updateTitle}</p>
            <p className="mt-0.5 text-[13px] break-words text-zinc-500 dark:text-zinc-400">
              {update.message || update.commit.slice(0, 7)}
            </p>
          </div>
          <Button size="sm" variant="primary" icon={<RefreshCw className="size-3.5" />} onClick={reload}>
            {t.reload}
          </Button>
        </div>
      )}
      <dl className="divide-y divide-zinc-900/5 dark:divide-white/5">
        <Row label={t.project}>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className={link}>
            {REPO_URL.replace('https://', '')}
            <ExternalLink className="size-3.5" />
          </a>
        </Row>
        <Row label={t.version}>
          {BUILD.commit ? (
            <>
              <a href={`${REPO_URL}/commit/${BUILD.commit}`} target="_blank" rel="noreferrer" className={`${link} font-mono`}>
                {BUILD.commit.slice(0, 7)}
              </a>
              {BUILD.message && <p className="mt-0.5 text-[13px] break-words text-zinc-500 dark:text-zinc-400">{BUILD.message}</p>}
            </>
          ) : (
            <span className="text-zinc-400">{t.unknown}</span>
          )}
        </Row>
        <Row label={t.runtime}>{RUNTIME[BUILD.runtime]}</Row>
        <Row label={t.builtAt}>
          <span className="tabular">{formatDateTime(BUILD.builtAt)}</span>
        </Row>
        <Row label={t.feedback}>
          <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer" className={link}>
            {t.reportIssue}
            <ExternalLink className="size-3.5" />
          </a>
        </Row>
      </dl>
      <ClearLocalData />
    </Card>
  );
}

function ClearLocalData() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  function clear() {
    if (!armed) return setArmed(true);
    clearAll([LOCALE_KEY]);
    window.location.reload();
  }

  return (
    <div className="mt-2 flex items-center gap-3 border-t border-zinc-900/5 pt-3 dark:border-white/5">
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-zinc-500 dark:text-zinc-400">
        {armed ? t.confirmHint : t.localData}
        <Hint>{t.localDataDetail}</Hint>
      </p>
      <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={clear}>
        {armed ? t.confirmClear : t.clear}
      </Button>
    </div>
  );
}
