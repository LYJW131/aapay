import { Check, Copy, History, LogIn, LogOut, ShieldCheck, UserPlus } from 'lucide-react';
import { motion } from 'motion/react';
import { useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { PublicConfig, SessionInfo } from '../../../shared/types.ts';
import { AutoHeight } from '../../components/AutoHeight.tsx';
import { Button } from '../../components/Button.tsx';
import { Label } from '../../components/Card.tsx';
import { LogoMark } from '../../components/Logo.tsx';
import { QrCode } from '../../components/QrCode.tsx';
import { roomInSheet, Sheet } from '../../components/Sheet.tsx';
import { api, call, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { ActivityPanel } from './Activity.tsx';
import { ConnectAI } from './ConnectAI.tsx';
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

type Tab = 'activity' | 'share' | 'ai';

export function Header({
  live,
  config,
  admin,
  onSwitch,
  onLeave,
}: {
  live: LiveStatus;
  config: PublicConfig;
  admin: boolean;
  onSwitch: (session: SessionInfo) => Promise<void>;
  onLeave: () => void;
}) {
  const { snapshot, session, activity } = useLedger();
  const { unread } = useSyncExternalStore(activity.subscribe, activity.getState);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('activity');
  const tabsRef = useRef<HTMLDivElement>(null);
  const status = LIVE[live];

  const tabs: { key: Tab; label: string }[] = [{ key: 'activity', label: '动态' }];
  if (session.role !== 'shared') tabs.push({ key: 'share', label: '邀请' });
  if (config.mcp) tabs.push({ key: 'ai', label: '连接 AI' });

  function show() {
    setTab('activity');
    setOpen(true);
    void activity.sync();
  }

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-900/5 bg-canvas/80 backdrop-blur-xl dark:border-white/5">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
        <LogoMark className="size-7 shrink-0" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] leading-tight font-semibold tracking-tight">
            <span className="mr-1">{snapshot.ledger.emoji}</span>
            {snapshot.ledger.name}
          </h1>
          <p className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            <span className={cn('size-1.5 rounded-full', status.dot)} />
            {/* 按最长的「实时同步」留宽，状态切换时后面的管理员标记不左右挪 */}
            <span className="min-w-[4em]">{status.label}</span>
            {session.role === 'admin' && <span className="rounded bg-brand-500/12 px-1 text-brand-600 dark:text-brand-300">管理员</span>}
          </p>
        </div>
        <Button size="sm" variant="secondary" className="relative" icon={<History className="size-4" />} onClick={show} aria-label="动态、邀请与连接 AI">
          {session.role === 'shared' ? '动态' : '动态 · 邀请'}
          {unread && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-rose-500 ring-2 ring-canvas" />}
        </Button>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title={`${snapshot.ledger.emoji} ${snapshot.ledger.name}`}>
        {tabs.length > 1 && (
          <div ref={tabsRef} className="sticky top-0 z-10 -mx-5 bg-surface px-5 pb-3">
            <div role="tablist" className="flex rounded-2xl bg-zinc-100 p-1 dark:bg-white/6">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => {
                    setTab(t.key);
                    tabsRef.current?.parentElement?.scrollTo({ top: 0 });
                  }}
                  className={cn(
                    'relative h-8 flex-1 rounded-xl text-[13px] font-medium transition-colors',
                    tab === t.key ? 'text-zinc-900 dark:text-white' : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
                  )}
                >
                  {tab === t.key && (
                    <motion.span
                      layoutId="header-tab"
                      className="absolute inset-0 rounded-xl bg-white shadow-sm ring-1 ring-zinc-900/5 dark:bg-white/12 dark:ring-white/5"
                      transition={{ type: 'spring', damping: 32, stiffness: 420 }}
                    />
                  )}
                  <span className="relative">{t.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {/* 顶部留出余量：吸顶标签栏的背景会盖住紧贴其下内容的描边和阴影（如二维码卡片） */}
        <AutoHeight max={roomInSheet} className="pt-1">
          {tab === 'activity' && <ActivityPanel />}
          {tab === 'share' && <ShareContent config={config} admin={admin} onSwitch={onSwitch} onLeave={onLeave} />}
          {tab === 'ai' && <ConnectAI admin={admin} />}
        </AutoHeight>
      </Sheet>
    </header>
  );
}

function ShareContent({
  config,
  admin,
  onSwitch,
  onLeave,
}: {
  config: PublicConfig;
  admin: boolean;
  onSwitch: (session: SessionInfo) => Promise<void>;
  onLeave: () => void;
}) {
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
      await onSwitch(next);
      toast.success(`已进入「${next.ledger.name}」`);
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
          你以管理员身份进入此账本，在页面顶部的「管理员」卡片里生成分享口令即可邀请成员。
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
          <Button type="submit" variant="soft" size="icon" className="size-11 rounded-2xl" loading={joining} aria-label="进入" icon={<LogIn className="size-4" />} />
        </div>
      </form>

      <div className="flex gap-2">
        {config.adminAuth !== 'disabled' && !admin && (
          <Button variant="ghost" className="flex-1" onClick={() => window.location.assign('/admin')} icon={<ShieldCheck className="size-4" />}>
            管理员登录
          </Button>
        )}
        <Button variant="danger" className="flex-1" onClick={leave} icon={<LogOut className="size-4" />}>
          退出此账本
        </Button>
      </div>
    </div>
  );
}
