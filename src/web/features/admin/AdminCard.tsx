import { Check, ChevronDown, Copy, Dices, FolderOpen, KeyRound, LogOut, Pencil, Plus, QrCode as QrIcon, Shield, Sparkles, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { LEDGER_EMOJIS } from '../../../shared/emoji.ts';
import { LIMITS } from '../../../shared/limits.ts';
import { formatMoney } from '../../../shared/money.ts';
import { randomPassphrase } from '../../../shared/passphrase.ts';
import type { AdminIdentity, LedgerOverview, Passphrase, RegistryEvent, SessionInfo } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { Label } from '../../components/Card.tsx';
import { QrCode } from '../../components/QrCode.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { Spinner } from '../../components/Spinner.tsx';
import { api, call, errorMessage, liveUrl } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { formatDateTime } from '../../lib/dates.ts';
import { useDelayed, usePersistentState } from '../../lib/hooks.ts';
import { joinLink } from '../ledger/Header.tsx';
import { adminCache } from './preload.ts';

// 断线期间可能漏掉事件，重连前先重新拉取；管理员会话过期时这次请求返回 401，卡片随之卸载，不再重连
function useAdminLive(onEvent: (event: RegistryEvent) => void, resync: () => Promise<void>) {
  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const connect = () => {
      ws = new WebSocket(liveUrl('/admin/live'));
      ws.onmessage = (e) => e.data !== 'pong' && onEvent(JSON.parse(e.data as string) as RegistryEvent);
      ws.onclose = () => {
        if (stopped) return;
        timer = setTimeout(async () => {
          await resync();
          if (!stopped) connect();
        }, 3000);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [onEvent, resync]);
}

interface Props {
  admin: AdminIdentity;
  current: SessionInfo | null;
  onEnter: (session: SessionInfo) => Promise<void>;
  standalone?: boolean;
}

export function AdminCard({ admin, current, onEnter, standalone = false }: Props) {
  const [collapsed, setCollapsed] = usePersistentState('aapay:admin:collapsed', false);
  const currentId = current?.ledger.id ?? null;
  const [ledgers, setLedgers] = useState<LedgerOverview[] | null>(() => adminCache.ledgers);
  const [passphrases, setPassphrases] = useState<Passphrase[] | null>(() => (currentId && adminCache.passphrases.get(currentId)) || null);
  const [qr, setQr] = useState<Passphrase | null>(null);
  const [deleting, setDeleting] = useState<LedgerOverview | null>(null);
  const open = standalone || !collapsed;

  const loadLedgers = useCallback(async () => {
    try {
      const list = await call(api.admin.ledgers.$get());
      adminCache.ledgers = list;
      setLedgers(list);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, []);

  const loadPassphrases = useCallback(async () => {
    if (!currentId) return;
    try {
      const list = await call(api.admin.ledgers[':id'].passphrases.$get({ param: { id: currentId } }));
      adminCache.passphrases.set(currentId, list);
      setPassphrases(list);
    } catch {
      setPassphrases([]);
    }
  }, [currentId]);

  useEffect(() => void loadLedgers(), [loadLedgers]);
  useEffect(() => void loadPassphrases(), [loadPassphrases]);

  useAdminLive(
    useCallback(
      (event: RegistryEvent) => {
        void loadLedgers();
        if (event.type === 'passphrases.changed' && event.ledgerId === currentId) void loadPassphrases();
      },
      [loadLedgers, loadPassphrases, currentId],
    ),
    useCallback(async () => {
      await Promise.all([loadLedgers(), loadPassphrases()]);
    }, [loadLedgers, loadPassphrases]),
  );

  async function logout() {
    await call(api.admin.logout.$post()).catch(() => undefined);
    window.location.replace('/');
  }

  return (
    <section className="card animate-fade-in overflow-hidden lg:col-span-2">
      <header
        className={cn('flex items-center gap-2 px-5 py-4', !standalone && 'cursor-pointer select-none')}
        onClick={standalone ? undefined : () => setCollapsed(!collapsed)}
      >
        <Shield className="size-[18px] shrink-0 text-brand-500 dark:text-brand-300" />
        <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-tight">
          管理员
          {current && <span className="font-normal text-zinc-400"> · {current.ledger.name}</span>}
        </h2>
        {!standalone && (
          <motion.span animate={{ rotate: open ? 0 : -90 }} transition={{ duration: 0.2 }} className="text-zinc-400">
            <ChevronDown className="size-4" />
          </motion.span>
        )}
        <span className="ml-auto hidden truncate text-xs text-zinc-400 sm:block">{admin.name}</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto sm:ml-0"
          icon={<LogOut className="size-3.5" />}
          onClick={(e) => {
            e.stopPropagation();
            void logout();
          }}
        >
          退出
        </Button>
      </header>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className={cn('grid gap-6 px-5 pb-5', current && 'lg:grid-cols-2')}>
              <Ledgers ledgers={ledgers} currentId={currentId} onEnter={onEnter} onChanged={loadLedgers} onDelete={setDeleting} />
              {current && (
                <Passphrases
                  ledgerId={current.ledger.id}
                  passphrases={passphrases}
                  onChanged={loadPassphrases}
                  onQr={setQr}
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Sheet open={!!qr} onClose={() => setQr(null)} title="邀请加入" description={current?.ledger.name}>
        {qr && <InviteContent passphrase={qr} />}
      </Sheet>
      <DeleteLedger
        ledger={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          void loadLedgers();
        }}
      />
    </section>
  );
}

function Ledgers({
  ledgers,
  currentId,
  onEnter,
  onChanged,
  onDelete,
}: {
  ledgers: LedgerOverview[] | null;
  currentId: string | null;
  onEnter: (session: SessionInfo) => Promise<void>;
  onChanged: () => void;
  onDelete: (ledger: LedgerOverview) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<LedgerOverview | null>(null);

  async function enter(id: string) {
    setBusy(id);
    try {
      await onEnter(await call(api.admin.ledgers[':id'].enter.$post({ param: { id } })));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy('create');
    try {
      const ledger = await call(api.admin.ledgers.$post({ json: { name: name.trim() } }));
      setName('');
      onChanged();
      toast.success(`已创建「${ledger.name}」，接下来为它生成一个分享口令吧`);
      await enter(ledger.id);
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(null);
    }
  }

  return (
    <div>
      <Label aside={ledgers && <span className="tabular">{ledgers.length} 个</span>}>
        <span className="flex items-center gap-1.5">
          <FolderOpen className="size-3.5" />
          账本
        </span>
      </Label>
      <form onSubmit={create} className="mb-2 flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.ledgerName} placeholder="新账本名称" className="field" />
        <Button type="submit" variant="soft" size="icon" className="size-11 rounded-2xl" loading={busy === 'create'} aria-label="创建账本" icon={<Plus className="size-5" />} />
      </form>
      {!ledgers ? (
        <div className="flex justify-center py-6 text-zinc-400">
          <Spinner className="size-5" />
        </div>
      ) : ledgers.length === 0 ? (
        <p className="rounded-2xl bg-zinc-50 px-4 py-6 text-center text-sm text-zinc-500 dark:bg-white/3">还没有账本，先创建一个吧</p>
      ) : (
        <ul className="space-y-1">
          <AnimatePresence initial={false}>
            {ledgers.map((l) => (
              <motion.li
                key={l.id}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
              >
                <LedgerRow
                  ledger={l}
                  current={l.id === currentId}
                  busy={busy === l.id}
                  onEnter={() => enter(l.id)}
                  onEdit={() => setEditing(l)}
                  onDelete={() => onDelete(l)}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      <Sheet open={!!editing} onClose={() => setEditing(null)} title="编辑账本">
        {editing && <LedgerEditor key={editing.id} ledger={editing} onDone={() => (setEditing(null), onChanged())} />}
      </Sheet>
    </div>
  );
}

function LedgerRow({
  ledger: l,
  current,
  busy,
  onEnter,
  onEdit,
  onDelete,
}: {
  ledger: LedgerOverview;
  current: boolean;
  busy: boolean;
  onEnter: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const spinning = useDelayed(busy);
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={current ? undefined : onEnter}
        disabled={busy}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-3 py-2 text-left transition',
          current ? 'bg-brand-500/10 dark:bg-brand-400/12' : 'hover:bg-zinc-900/4 dark:hover:bg-white/5',
        )}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500/15 to-accent-500/15 text-lg text-brand-600 dark:text-brand-300">
          {spinning ? <Spinner className="size-4" /> : l.emoji}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{l.name}</span>
            {current && <span className="shrink-0 rounded bg-brand-500/15 px-1 text-[10px] font-medium text-brand-600 dark:text-brand-300">当前</span>}
          </span>
          <span className="tabular block truncate text-xs text-zinc-500 dark:text-zinc-400">
            {l.stats ? `${l.stats.members} 人 · ${l.stats.expenses} 笔 · ${formatMoney(l.stats.total)}` : '—'}
          </span>
        </span>
        {l.connections > 0 && (
          <span title="已连接的 AI 应用" className="flex shrink-0 items-center gap-0.5 text-[11px] text-brand-600 dark:text-brand-300">
            <Sparkles className="size-3" />
            {l.connections}
          </span>
        )}
        {l.activePassphrases > 0 && (
          <span title="生效中的口令" className="flex shrink-0 items-center gap-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
            <KeyRound className="size-3" />
            {l.activePassphrases}
          </span>
        )}
      </button>
      <Button size="icon" variant="ghost" className="size-9 text-zinc-400" onClick={onEdit} aria-label="编辑账本">
        <Pencil className="size-4" />
      </Button>
      <Button size="icon" variant="ghost" className="size-9 text-zinc-400 hover:bg-rose-500/10 hover:text-rose-500" onClick={onDelete} aria-label="删除账本">
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

function LedgerEditor({ ledger, onDone }: { ledger: LedgerOverview; onDone: () => void }) {
  const [name, setName] = useState(ledger.name);
  const [emoji, setEmoji] = useState(ledger.emoji);
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (name.trim() === ledger.name && emoji === ledger.emoji) return onDone();
    setSaving(true);
    try {
      await call(api.admin.ledgers[':id'].$patch({ param: { id: ledger.id }, json: { name: name.trim(), emoji } }));
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-5 pb-1">
      <div className="flex justify-center pt-1">
        <span className="flex size-20 items-center justify-center rounded-3xl bg-gradient-to-br from-brand-500/15 to-accent-500/15 text-5xl">
          {emoji}
        </span>
      </div>
      <div>
        <Label>图标</Label>
        <div className="grid grid-cols-6 gap-2">
          {LEDGER_EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setEmoji(e)}
              aria-pressed={emoji === e}
              className={cn(
                'flex aspect-square items-center justify-center rounded-2xl text-2xl transition active:scale-90',
                emoji === e ? 'bg-brand-500/15 ring-2 ring-brand-500' : 'bg-zinc-100 hover:bg-zinc-200 dark:bg-white/6',
              )}
            >
              {e}
            </button>
          ))}
        </div>
        <input
          value={LEDGER_EMOJIS.includes(emoji) ? '' : emoji}
          onChange={(e) => setEmoji([...new Intl.Segmenter().segment(e.target.value)].at(-1)?.segment ?? ledger.emoji)}
          placeholder="或输入任意 emoji"
          aria-label="自定义图标"
          className="field mt-2 text-center"
        />
      </div>
      <div>
        <Label>名称</Label>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.ledgerName} className="field" aria-label="账本名称" />
      </div>
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={saving}>
        保存
      </Button>
    </form>
  );
}

function DeleteLedger({ ledger, onClose, onDeleted }: { ledger: LedgerOverview | null; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!ledger) return;
    setBusy(true);
    try {
      await call(api.admin.ledgers[':id'].$delete({ param: { id: ledger.id } }));
      toast.success(`已删除「${ledger.name}」`);
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={!!ledger} onClose={onClose} title={`删除「${ledger?.name ?? ''}」？`}>
      <div className="space-y-4 pb-1">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          账本内的所有成员、支出和还款记录都会被永久删除，所有口令与 AI 连接立即失效，在线成员会被移出。此操作不可恢复。
        </p>
        <div className="flex gap-2">
          <Button className="flex-1" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" className="flex-1 bg-rose-500! text-white!" loading={busy} onClick={remove}>
            永久删除
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function Passphrases({
  ledgerId,
  passphrases,
  onChanged,
  onQr,
}: {
  ledgerId: string;
  passphrases: Passphrase[] | null;
  onChanged: () => void;
  onQr: (p: Passphrase) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function revoke(p: Passphrase) {
    setBusy(p.id);
    try {
      await call(api.admin.passphrases[':id'].$delete({ param: { id: p.id } }));
      toast.success(`已撤销口令 ${p.code}，使用它加入的成员已被移出`);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <Label>
        <span className="flex items-center gap-1.5">
          <KeyRound className="size-3.5" />
          分享口令
        </span>
      </Label>
      <PassphraseForm ledgerId={ledgerId} onCreated={(p) => (onChanged(), onQr(p))} />
      <div className="mt-3">
        {!passphrases ? (
          <div className="flex justify-center py-6 text-zinc-400">
            <Spinner className="size-5" />
          </div>
        ) : passphrases.length === 0 ? (
          <p className="rounded-2xl bg-zinc-50 px-4 py-6 text-center text-sm text-zinc-500 dark:bg-white/3">
            还没有口令，生成后把它或邀请链接发给大家即可加入
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-white/5">
            <AnimatePresence initial={false}>
              {passphrases.map((p) => (
                <motion.li
                  key={p.id}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <PassphraseRow passphrase={p} busy={busy === p.id} onQr={() => onQr(p)} onRevoke={() => revoke(p)} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  );
}

type Validity = '1d' | '7d' | '30d' | 'forever' | 'custom';
const VALIDITY: { key: Validity; label: string; days?: number }[] = [
  { key: '1d', label: '1 天', days: 1 },
  { key: '7d', label: '7 天', days: 7 },
  { key: '30d', label: '30 天', days: 30 },
  { key: 'forever', label: '永久' },
  { key: 'custom', label: '自定义' },
];

const toLocalInput = (ts: number) => {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

function PassphraseForm({ ledgerId, onCreated }: { ledgerId: string; onCreated: (p: Passphrase) => void }) {
  const [code, setCode] = useState(randomPassphrase);
  const [validity, setValidity] = useState<Validity>('7d');
  const [from, setFrom] = useState(() => toLocalInput(Date.now()));
  const [until, setUntil] = useState(() => toLocalInput(Date.now() + 7 * 86_400_000));
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const preset = VALIDITY.find((v) => v.key === validity)!;
    const now = Date.now();
    const range =
      validity === 'custom'
        ? { validFrom: new Date(from).getTime(), validUntil: new Date(until).getTime() }
        : { validFrom: now, validUntil: preset.days ? now + preset.days * 86_400_000 : null };
    setSaving(true);
    try {
      const p = await call(api.admin.ledgers[':id'].passphrases.$post({ param: { id: ledgerId }, json: { code: code.trim(), ...range } }));
      setCode(randomPassphrase());
      onCreated(p);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2.5">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={LIMITS.codeMax}
            placeholder={`口令（${LIMITS.codeMin}-${LIMITS.codeMax} 位字母或数字）`}
            autoCapitalize="off"
            spellCheck={false}
            className="field pr-11 font-mono tracking-wider"
          />
          <button
            type="button"
            onClick={() => setCode(randomPassphrase())}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-900/5 hover:text-brand-600"
            aria-label="随机生成"
            title="随机生成"
          >
            <Dices className="size-4" />
          </button>
        </div>
        <Button type="submit" variant="primary" loading={saving} icon={<Plus className="size-4" />}>
          生成
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-zinc-500">有效期</span>
        {VALIDITY.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => setValidity(v.key)}
            className={cn(
              'h-7 rounded-full px-3 text-xs font-medium transition',
              validity === v.key
                ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-white/6 dark:text-zinc-300',
            )}
          >
            {v.label}
          </button>
        ))}
      </div>
      {validity === 'custom' && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label>
            <Label>开始</Label>
            <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className="field tabular px-3" />
          </label>
          <label>
            <Label>结束</Label>
            <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} className="field tabular px-3" />
          </label>
        </div>
      )}
    </form>
  );
}

function status(p: Passphrase) {
  const now = Date.now();
  if (p.validFrom > now) return { label: '未生效', className: 'bg-amber-500/12 text-amber-700 dark:text-amber-400' };
  if (p.validUntil !== null && p.validUntil <= now) return { label: '已过期', className: 'bg-zinc-500/12 text-zinc-500' };
  return { label: '生效中', className: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400' };
}

function PassphraseRow({ passphrase: p, busy, onQr, onRevoke }: { passphrase: Passphrase; busy: boolean; onQr: () => void; onRevoke: () => void }) {
  const st = status(p);
  return (
    <div className="flex items-center gap-2 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[15px] font-semibold tracking-wider">{p.code}</span>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', st.className)}>{st.label}</span>
        </div>
        <p className="tabular mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
          {formatDateTime(p.validFrom)} → {p.validUntil ? formatDateTime(p.validUntil) : '永久有效'}
        </p>
      </div>
      <Button size="icon" variant="ghost" className="size-9" onClick={onQr} aria-label="二维码与链接">
        <QrIcon className="size-4" />
      </Button>
      <Button size="icon" variant="ghost" className="size-9 text-rose-500 hover:bg-rose-500/10" onClick={onRevoke} loading={busy} aria-label="撤销口令" icon={<Trash2 className="size-4" />} />
    </div>
  );
}

function InviteContent({ passphrase }: { passphrase: Passphrase }) {
  const link = joinLink(passphrase.code);
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);
  const copy = async (text: string, what: 'link' | 'code') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      toast.error('复制失败');
    }
  };
  return (
    <div className="flex flex-col items-center gap-4 pb-1">
      <div className="rounded-3xl bg-white p-4 text-zinc-900 shadow-sm ring-1 ring-zinc-900/5">
        <QrCode value={link} className="size-52" />
      </div>
      <button onClick={() => copy(passphrase.code, 'code')} className="group text-center" title="点击复制口令">
        <p className="text-sm text-zinc-500">口令</p>
        <p className="mt-1 flex items-center gap-2 font-mono text-2xl font-semibold tracking-[0.2em]">
          {passphrase.code}
          {copied === 'code' ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4 text-zinc-300 group-hover:text-zinc-500" />}
        </p>
      </button>
      <p className="w-full truncate rounded-xl bg-zinc-50 px-3 py-2 text-center font-mono text-xs text-zinc-500 dark:bg-white/4">{link}</p>
      <Button variant="primary" className="w-full" onClick={() => copy(link, 'link')} icon={copied === 'link' ? <Check className="size-4" /> : <Copy className="size-4" />}>
        {copied === 'link' ? '已复制' : '复制邀请链接'}
      </Button>
    </div>
  );
}
