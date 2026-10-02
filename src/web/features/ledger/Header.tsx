import { Check, Copy, LayoutDashboard, LogIn, LogOut, Share2, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { PublicConfig } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { Label } from '../../components/Card.tsx';
import { LogoMark } from '../../components/Logo.tsx';
import { QrCode } from '../../components/QrCode.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { api, call, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { useLedger } from './context.tsx';
import type { LiveStatus } from './store.ts';

const LIVE: Record<LiveStatus, { label: string; dot: string }> = {
  online: { label: '实时同步', dot: 'bg-emerald-500' },
  connecting: { label: '连接中', dot: 'bg-amber-400 animate-pulse' },
  offline: { label: '已离线', dot: 'bg-rose-500' },
};

export function joinLink(code: string) {
  return `${window.location.origin}/join#${encodeURIComponent(code)}`;
}

export function Header({ live, config, onLeave }: { live: LiveStatus; config: PublicConfig; onLeave: () => void }) {
  const { snapshot, session } = useLedger();
  const [shareOpen, setShareOpen] = useState(false);
  const status = LIVE[live];

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-900/5 bg-canvas/80 backdrop-blur-xl dark:border-white/5">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
        <LogoMark className="size-7 shrink-0" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] leading-tight font-semibold tracking-tight">{snapshot.ledger.name}</h1>
          <p className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            <span className={cn('size-1.5 rounded-full', status.dot)} />
            {status.label}
            {session.role === 'admin' && <span className="rounded bg-brand-500/12 px-1 text-brand-600 dark:text-brand-300">管理员</span>}
          </p>
        </div>
        {session.role === 'admin' && (
          <Button size="sm" variant="ghost" icon={<LayoutDashboard className="size-4" />} onClick={() => window.location.assign('/admin')}>
            <span className="hidden sm:inline">控制台</span>
          </Button>
        )}
        {session.role !== 'shared' && (
          <Button size="sm" variant="secondary" icon={<Share2 className="size-4" />} onClick={() => setShareOpen(true)}>
            邀请
          </Button>
        )}
      </div>
      {session.role !== 'shared' && (
        <Sheet open={shareOpen} onClose={() => setShareOpen(false)} title="邀请与切换" description={snapshot.ledger.name}>
          <ShareContent config={config} onLeave={onLeave} />
        </Sheet>
      )}
    </header>
  );
}

function ShareContent({ config, onLeave }: { config: PublicConfig; onLeave: () => void }) {
  const { session } = useLedger();
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const link = session.passphrase ? joinLink(session.passphrase) : null;

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('复制失败，请长按链接手动复制');
    }
  }

  async function switchLedger(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setJoining(true);
    try {
      const next = await call(api.join.$post({ json: { code: code.trim() } }));
      toast.success(`已进入「${next.ledger.name}」`);
      window.location.replace('/');
    } catch (err) {
      toast.error(errorMessage(err));
      setJoining(false);
    }
  }

  async function leave() {
    await call(api.logout.$post()).catch(() => undefined);
    onLeave();
  }

  return (
    <div className="space-y-6 pb-1">
      {link ? (
        <div className="flex flex-col items-center gap-4">
          <div className="rounded-3xl bg-white p-4 text-zinc-900 shadow-sm ring-1 ring-zinc-900/5">
            <QrCode value={link} className="size-48" />
          </div>
          <div className="text-center">
            <p className="text-sm text-zinc-500">扫码或打开链接即可加入，口令</p>
            <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.2em]">{session.passphrase}</p>
          </div>
          <div className="flex w-full gap-2">
            <Button variant="primary" className="flex-1" onClick={copy} icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}>
              {copied ? '已复制' : '复制邀请链接'}
            </Button>
            {'share' in navigator && (
              <Button
                variant="secondary"
                size="icon"
                className="size-11 rounded-2xl"
                aria-label="系统分享"
                onClick={() => navigator.share({ title: 'AAPay 记账邀请', url: link }).catch(() => undefined)}
              >
                <UserPlus className="size-4" />
              </Button>
            )}
          </div>
        </div>
      ) : (
        <p className="rounded-2xl bg-zinc-50 px-4 py-3 text-sm text-zinc-500 dark:bg-white/4">
          你以管理员身份进入此账本。前往 <button className="text-brand-600 underline" onClick={() => window.location.assign('/admin')}>控制台</button> 创建分享口令邀请成员。
        </p>
      )}

      <form onSubmit={switchLedger}>
        <Label>切换到其他账本</Label>
        <div className="flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="输入分享口令"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="field font-mono tracking-wider"
          />
          <Button type="submit" variant="soft" size="icon" className="size-11 rounded-2xl" loading={joining} aria-label="进入">
            {!joining && <LogIn className="size-4" />}
          </Button>
        </div>
      </form>

      <div className="flex gap-2">
        {config.adminAuth !== 'disabled' && session.role !== 'admin' && (
          <Button variant="ghost" className="flex-1" onClick={() => window.location.assign('/admin')} icon={<LayoutDashboard className="size-4" />}>
            管理控制台
          </Button>
        )}
        <Button variant="danger" className="flex-1" onClick={leave} icon={<LogOut className="size-4" />}>
          退出此账本
        </Button>
      </div>
    </div>
  );
}
