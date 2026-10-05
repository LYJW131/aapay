import { ExternalLink, Info, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button.tsx';
import { Card } from '../../components/Card.tsx';
import { formatDateTime } from '../../lib/dates.ts';
import { BUILD, REPO_URL, useDeployedUpdate } from '../../lib/version.ts';

const link = 'inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-300';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-2.5 text-sm">
      <dt className="w-16 shrink-0 text-zinc-500 dark:text-zinc-400">{label}</dt>
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
      title="关于"
      icon={<Info />}
      action={
        update && (
          <button onClick={reload} className="rounded-full bg-brand-500/12 px-2 py-0.5 text-xs font-medium text-brand-600 dark:text-brand-300">
            有更新
          </button>
        )
      }
    >
      {update && (
        <div className="mb-2 flex items-center gap-3 rounded-2xl bg-brand-500/8 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">新版本已上线</p>
            <p className="mt-0.5 text-[13px] break-words text-zinc-500 dark:text-zinc-400">
              {update.message || update.commit.slice(0, 7)}
            </p>
          </div>
          <Button size="sm" variant="primary" icon={<RefreshCw className="size-3.5" />} onClick={reload}>
            刷新
          </Button>
        </div>
      )}
      <dl className="divide-y divide-zinc-900/5 dark:divide-white/5">
        <Row label="项目">
          <a href={REPO_URL} target="_blank" rel="noreferrer" className={link}>
            {REPO_URL.replace('https://', '')}
            <ExternalLink className="size-3.5" />
          </a>
        </Row>
        <Row label="版本">
          {BUILD.commit ? (
            <>
              <a href={`${REPO_URL}/commit/${BUILD.commit}`} target="_blank" rel="noreferrer" className={`${link} font-mono`}>
                {BUILD.commit.slice(0, 7)}
              </a>
              {BUILD.message && <p className="mt-0.5 text-[13px] break-words text-zinc-500 dark:text-zinc-400">{BUILD.message}</p>}
            </>
          ) : (
            <span className="text-zinc-400">未知</span>
          )}
        </Row>
        <Row label="构建时间">
          <span className="tabular">{formatDateTime(BUILD.builtAt)}</span>
        </Row>
        <Row label="反馈">
          <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer" className={link}>
            提交 Issue
            <ExternalLink className="size-3.5" />
          </a>
        </Row>
      </dl>
    </Card>
  );
}
