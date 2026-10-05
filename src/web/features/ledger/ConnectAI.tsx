import { Check, Copy } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { Connection } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { Label } from '../../components/Card.tsx';
import { ConnectionList } from '../../components/ConnectionList.tsx';
import { connect as t } from '../../i18n/connect.ts';
import { api, call, errorMessage } from '../../lib/api.ts';
import { useLedger } from './context.tsx';

export const mcpUrl = () => `${window.location.origin}/mcp`;

// 授权通常在另一个标签页完成，回到这里时刷新
const cache = new Map<string, Connection[]>();

function useConnections(cacheKey: string, list: () => Promise<Connection[]>, remove: (id: string) => Promise<unknown>) {
  const [connections, setConnections] = useState<Connection[] | null>(() => cache.get(cacheKey) ?? null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await list();
      cache.set(cacheKey, result);
      setConnections(result);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [cacheKey, list]);

  useEffect(() => {
    void load();
    const onFocus = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onFocus);
    return () => document.removeEventListener('visibilitychange', onFocus);
  }, [load]);

  async function disconnect(c: Connection) {
    setBusy(c.id);
    try {
      await remove(c.id);
      setConnections((all) => {
        const next = all?.filter((x) => x.id !== c.id) ?? null;
        if (next) cache.set(cacheKey, next);
        return next;
      });
      toast.success(t.ai.disconnected(c.clientName ?? c.clientHost ?? t.ai.fallbackApp));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return { connections, busy, disconnect };
}

const ledgerConnections = () => call(api.ledger.connections.$get());
const removeLedgerConnection = (id: string) => call(api.ledger.connections[':id'].$delete({ param: { id } }));
const adminConnections = () => call(api.admin.connections.$get());
const removeAdminConnection = (id: string) => call(api.admin.connections[':id'].$delete({ param: { id } }));

export function ConnectAI({ admin }: { admin: boolean }) {
  const [copied, setCopied] = useState(false);
  const { session } = useLedger();
  const ledger = useConnections(`ledger:${session.ledger.id}`, ledgerConnections, removeLedgerConnection);

  async function copy() {
    try {
      await navigator.clipboard.writeText(mcpUrl());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error(t.ai.copyFailed);
    }
  }

  return (
    <div className="space-y-6 pb-1">
      <div>
        <Label>{t.ai.serverUrl}</Label>
        <div className="flex gap-2">
          <input readOnly value={mcpUrl()} onFocus={(e) => e.currentTarget.select()} className="field font-mono" />
          <Button
            variant="primary"
            size="icon"
            className="size-11 rounded-2xl"
            aria-label={t.ai.copyUrl}
            onClick={copy}
            icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          />
        </div>
        <ol className="mt-3 space-y-2">
          {t.ai.steps.map((s) => (
            <li key={s.app} className="flex gap-2.5 text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              <span className="mt-0.5 h-fit shrink-0 rounded-md bg-zinc-100 px-1.5 text-[11px] font-medium text-zinc-600 dark:bg-white/8 dark:text-zinc-300">
                {s.app}
              </span>
              {s.how}
            </li>
          ))}
        </ol>
        <p className="mt-3 rounded-2xl bg-brand-500/8 px-4 py-3 text-[13px] leading-relaxed text-brand-700 dark:text-brand-200">
          {admin ? t.ai.hintAdmin : t.ai.hintMember}
        </p>
      </div>

      <div>
        <Label aside={ledger.connections && ledger.connections.length > 0 && <span className="tabular">{ledger.connections.length}</span>}>
          {t.ai.ledgerConnections}
        </Label>
        <ConnectionList connections={ledger.connections} busy={ledger.busy} onDisconnect={ledger.disconnect} />
      </div>

      {admin && <AdminConnections />}
    </div>
  );
}

function AdminConnections() {
  const { connections, busy, disconnect } = useConnections('admin', adminConnections, removeAdminConnection);
  return (
    <div>
      <Label aside={connections && connections.length > 0 && <span className="tabular">{connections.length}</span>}>{t.ai.adminConnections}</Label>
      <ConnectionList connections={connections} busy={busy} onDisconnect={disconnect} empty={t.ai.adminEmpty} />
    </div>
  );
}
