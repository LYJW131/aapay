import { Check, Copy, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { Connection } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { Card } from '../../components/Card.tsx';
import { ConnectionList } from '../../components/ConnectionList.tsx';
import { api, call, errorMessage } from '../../lib/api.ts';
import { mcpUrl } from '../ledger/ConnectAI.tsx';

/** 以管理员身份连接、可管理全部账本的 AI 应用；version 变化时重新加载 */
export function AiConnections({ version }: { version: number }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setConnections(await call(api.admin.connections.$get()));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, []);

  useEffect(() => void load(), [load, version]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(mcpUrl());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('复制失败，请手动复制');
    }
  }

  async function disconnect(c: Connection) {
    setBusy(c.id);
    try {
      await call(api.admin.connections[':id'].$delete({ param: { id: c.id } }));
      setConnections((list) => list?.filter((x) => x.id !== c.id) ?? null);
      toast.success(`已断开 ${c.clientName ?? c.clientHost ?? 'AI 应用'}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="AI 助手（管理员）" icon={<Sparkles />}>
      <p className="mb-3 text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">
        在 Claude、ChatGPT 中添加下面的 MCP 地址，授权时选择「全部账本」，AI 就能帮你管理所有账本：创建账本、生成口令、记账查账。
      </p>
      <div className="mb-4 flex gap-2">
        <input readOnly value={mcpUrl()} onFocus={(e) => e.currentTarget.select()} className="field font-mono text-sm" />
        <Button
          variant="soft"
          size="icon"
          className="size-11 rounded-2xl"
          aria-label="复制地址"
          onClick={copy}
          icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        />
      </div>
      <ConnectionList connections={connections} busy={busy} onDisconnect={disconnect} empty="还没有以管理员身份连接的 AI 应用" />
    </Card>
  );
}
