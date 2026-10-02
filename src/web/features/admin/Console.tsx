import {
  BookOpen,
  Check,
  Copy,
  DoorOpen,
  Dices,
  KeyRound,
  Pencil,
  Plus,
  QrCode as QrIcon,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { formatMoney } from '../../../shared/money.ts';
import { LIMITS } from '../../../shared/limits.ts';
import type { LedgerOverview, Passphrase, RegistryEvent } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { Card, Empty, Label } from '../../components/Card.tsx';
import { QrCode } from '../../components/QrCode.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { Spinner } from '../../components/Spinner.tsx';
import { api, call, errorMessage, liveUrl } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { formatDateTime, relativeTime } from '../../lib/dates.ts';
import { usePersistentState } from '../../lib/hooks.ts';
import { joinLink } from '../ledger/Header.tsx';

/** 订阅管理端实时事件：其他设备上的操作会即时同步过来 */
function useConsoleLive(onEvent: (event: RegistryEvent) => void) {
  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let retries = 0;
    let stopped = false;
    const connect = () => {
      ws = new WebSocket(liveUrl('/admin/live'));
      ws.onopen = () => (retries = 0);
      ws.onmessage = (e) => e.data !== 'pong' && onEvent(JSON.parse(e.data as string) as RegistryEvent);
      ws.onclose = () => {
        if (!stopped) timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retries++));
      };
    };
    connect();
    const ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ping);
      ws?.close();
    };
  }, [onEvent]);
}

export function Console() {
  const [ledgers, setLedgers] = useState<LedgerOverview[] | null>(null);
  const [selectedId, setSelectedId] = usePersistentState<string | null>('aapay:console:selected', null);
  const [passphrases, setPassphrases] = useState<Passphrase[] | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const selected = ledgers?.find((l) => l.id === selectedId) ?? ledgers?.[0] ?? null;

  const loadLedgers = useCallback(async () => {
    try {
      setLedgers(await call(api.admin.ledgers.$get()));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, []);

  const loadPassphrases = useCallback(async (id: string) => {
    try {
      setPassphrases(await call(api.admin.ledgers[':id'].passphrases.$get({ param: { id } })));
    } catch {
      setPassphrases([]);
    }
  }, []);

  useEffect(() => void loadLedgers(), [loadLedgers]);
  useEffect(() => {
    setPassphrases(null);
    if (selected) void loadPassphrases(selected.id);
  }, [selected?.id, loadPassphrases]);

  useConsoleLive(
    useCallback(
      (event: RegistryEvent) => {
        void loadLedgers();
        if (event.type === 'passphrases.changed' && event.ledgerId === selected?.id) void loadPassphrases(event.ledgerId);
      },
      [loadLedgers, loadPassphrases, selected?.id],
    ),
  );

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const ledger = await call(api.admin.ledgers.$post({ json: { name: name.trim() } }));
      setName('');
      setSelectedId(ledger.id);
      await loadLedgers();
      toast.success(`已创建「${ledger.name}」，接下来为它生成一个分享口令吧`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-5 lg:grid lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start lg:gap-5 lg:py-6">
      <Card title="账本" icon={<BookOpen />} action={ledgers && <span className="text-xs text-zinc-400">{ledgers.length} 个</span>}>
        <form onSubmit={create} className="mb-4 flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.ledgerName} placeholder="新账本名称" className="field" />
          <Button type="submit" variant="soft" size="icon" className="size-11 rounded-2xl" loading={creating} aria-label="创建账本">
            {!creating && <Plus className="size-5" />}
          </Button>
        </form>
        {!ledgers ? (
          <div className="flex justify-center py-8 text-zinc-400">
            <Spinner className="size-6" />
          </div>
        ) : ledgers.length === 0 ? (
          <Empty icon={<BookOpen />} title="还没有账本" hint="创建一个账本，再生成口令发给朋友" />
        ) : (
          <ul className="-mx-2 space-y-0.5">
            {ledgers.map((l) => (
              <li key={l.id}>
                <button
                  onClick={() => setSelectedId(l.id)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition',
                    selected?.id === l.id ? 'bg-brand-500/10 dark:bg-brand-400/12' : 'hover:bg-zinc-900/4 dark:hover:bg-white/5',
                  )}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500/15 to-accent-500/15 text-[15px] font-semibold text-brand-600 dark:text-brand-300">
                    {[...l.name][0]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{l.name}</span>
                    <span className="tabular block truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {l.stats ? `${l.stats.members} 人 · ${l.stats.expenses} 笔 · ${formatMoney(l.stats.total)}` : '—'}
                    </span>
                  </span>
                  {l.activePassphrases > 0 && (
                    <span className="flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                      <KeyRound className="size-3" />
                      {l.activePassphrases}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-4 space-y-4 lg:mt-0">
        {selected && (
          <LedgerDetail
            key={selected.id}
            ledger={selected}
            passphrases={passphrases}
            onChanged={() => {
              void loadLedgers();
              void loadPassphrases(selected.id);
            }}
          />
        )}
      </div>
    </main>
  );
}

function LedgerDetail({
  ledger,
  passphrases,
  onChanged,
}: {
  ledger: LedgerOverview;
  passphrases: Passphrase[] | null;
  onChanged: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(ledger.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [qr, setQr] = useState<Passphrase | null>(null);

  async function rename(e: FormEvent) {
    e.preventDefault();
    setBusy('rename');
    try {
      await call(api.admin.ledgers[':id'].$patch({ param: { id: ledger.id }, json: { name: name.trim() } }));
      setRenaming(false);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function enter() {
    setBusy('enter');
    try {
      await call(api.admin.ledgers[':id'].enter.$post({ param: { id: ledger.id } }));
      window.location.assign('/');
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('delete');
    try {
      await call(api.admin.ledgers[':id'].$delete({ param: { id: ledger.id } }));
      toast.success(`已删除「${ledger.name}」`);
      setConfirmDelete(false);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(null);
    }
  }

  async function revoke(p: Passphrase) {
    setBusy(p.id);
    try {
      await call(api.admin.passphrases[':id'].$delete({ param: { id: p.id } }));
      toast.success(`已撤销口令 ${p.code}，使用它登录的成员已被移出`);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const s = ledger.stats;

  return (
    <>
      <section className="card animate-fade-in p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {renaming ? (
            <form onSubmit={rename} className="flex min-w-0 flex-1 gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.ledgerName} autoFocus className="field" />
              <Button type="submit" variant="primary" size="icon" className="size-11 rounded-2xl" loading={busy === 'rename'} aria-label="保存">
                {busy !== 'rename' && <Check className="size-4" />}
              </Button>
              <Button variant="ghost" size="icon" className="size-11 rounded-2xl" onClick={() => setRenaming(false)} aria-label="取消">
                <X className="size-4" />
              </Button>
            </form>
          ) : (
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
                <span className="truncate">{ledger.name}</span>
                <button onClick={() => setRenaming(true)} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-900/5 hover:text-zinc-600" aria-label="重命名">
                  <Pencil className="size-4" />
                </button>
              </h2>
              <p className="mt-0.5 text-xs text-zinc-500">创建于 {formatDateTime(ledger.createdAt)}</p>
            </div>
          )}
          {!renaming && (
            <div className="flex gap-2">
              <Button variant="danger" size="sm" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete(true)}>
                删除
              </Button>
              <Button variant="primary" size="sm" loading={busy === 'enter'} icon={<DoorOpen className="size-3.5" />} onClick={enter}>
                进入账本
              </Button>
            </div>
          )}
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['成员', s ? `${s.members} 人` : '—'],
            ['支出', s ? `${s.expenses} 笔` : '—'],
            ['总额', s ? formatMoney(s.total) : '—'],
            ['最近活动', s?.lastActivityAt ? relativeTime(s.lastActivityAt) : '暂无'],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl bg-zinc-50 px-4 py-3 dark:bg-white/4">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
              <dd className="tabular mt-1 truncate text-[15px] font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Card title="分享口令" icon={<KeyRound />}>
        <PassphraseForm ledgerId={ledger.id} onCreated={(p) => (onChanged(), setQr(p))} />
        <div className="mt-5">
          {!passphrases ? (
            <div className="flex justify-center py-6 text-zinc-400">
              <Spinner className="size-5" />
            </div>
          ) : passphrases.length === 0 ? (
            <Empty icon={<KeyRound />} title="还没有口令" hint="生成口令后，把它或邀请链接发给大家即可加入" />
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-white/5">
              {passphrases.map((p) => (
                <PassphraseRow key={p.id} passphrase={p} busy={busy === p.id} onQr={() => setQr(p)} onRevoke={() => revoke(p)} />
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Sheet open={!!qr} onClose={() => setQr(null)} title="邀请加入" description={ledger.name}>
        {qr && <InviteContent passphrase={qr} />}
      </Sheet>
      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`删除「${ledger.name}」？`}>
        <div className="space-y-4 pb-1">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            账本内的所有成员、支出和还款记录都会被永久删除，所有口令立即失效，在线成员会被移出。此操作不可恢复。
          </p>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => setConfirmDelete(false)}>
              取消
            </Button>
            <Button variant="danger" className="flex-1 bg-rose-500! text-white!" loading={busy === 'delete'} onClick={remove}>
              永久删除
            </Button>
          </div>
        </div>
      </Sheet>
    </>
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

function randomCode(length = 6) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(length))].map((b) => alphabet[b % alphabet.length]).join('');
}

function PassphraseForm({ ledgerId, onCreated }: { ledgerId: string; onCreated: (p: Passphrase) => void }) {
  const [code, setCode] = useState(randomCode);
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
      setCode(randomCode());
      onCreated(p);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
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
            onClick={() => setCode(randomCode())}
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
            <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className="field tabular px-3 text-sm" />
          </label>
          <label>
            <Label>结束</Label>
            <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} className="field tabular px-3 text-sm" />
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
    <li className="flex items-center gap-3 py-3">
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
      <Button size="icon" variant="ghost" className="size-9 text-rose-500 hover:bg-rose-500/10" onClick={onRevoke} loading={busy} aria-label="撤销口令">
        {!busy && <Trash2 className="size-4" />}
      </Button>
    </li>
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
