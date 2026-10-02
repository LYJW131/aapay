import { PlugZap, Sparkles, Unplug } from 'lucide-react';
import type { Connection } from '../../shared/types.ts';
import { relativeTime } from '../lib/dates.ts';
import { Button } from './Button.tsx';
import { Spinner } from './Spinner.tsx';

export function ConnectionList({
  connections,
  busy,
  onDisconnect,
  empty = '还没有连接的 AI 应用',
}: {
  connections: Connection[] | null;
  busy: string | null;
  onDisconnect: (c: Connection) => void;
  empty?: string;
}) {
  if (connections === null) {
    return (
      <div className="flex justify-center py-6 text-zinc-400">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (connections.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-2xl bg-zinc-50 px-4 py-6 text-center dark:bg-white/3">
        <PlugZap className="mb-2 size-7 text-zinc-300 dark:text-zinc-600" />
        <p className="text-sm text-zinc-500">{empty}</p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-zinc-900/5 rounded-2xl bg-zinc-50 dark:divide-white/5 dark:bg-white/4">
      {connections.map((c) => (
        <li key={c.id} className="flex items-center gap-3 px-4 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-zinc-800 to-zinc-950 text-white dark:from-white/14 dark:to-white/6">
            <Sparkles className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{c.clientName ?? c.clientHost ?? '未命名应用'}</span>
              <span className="shrink-0 rounded bg-zinc-900/5 px-1 text-[10px] text-zinc-500 dark:bg-white/8 dark:text-zinc-400">
                {c.scopes.includes('ledger:write') ? '可修改' : '只读'}
              </span>
            </span>
            <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
              {[c.subject, c.clientHost, `${relativeTime(c.lastUsedAt)}使用`].filter(Boolean).join(' · ')}
            </span>
          </span>
          <Button size="sm" variant="danger" loading={busy === c.id} icon={<Unplug className="size-3.5" />} onClick={() => onDisconnect(c)}>
            断开
          </Button>
        </li>
      ))}
    </ul>
  );
}
