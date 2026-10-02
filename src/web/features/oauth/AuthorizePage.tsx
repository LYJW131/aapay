import { ArrowLeftRight, Check, CircleCheck, Eye, KeyRound, PenLine, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { LIMITS } from '../../../shared/limits.ts';
import type { AdminIdentity, AuthorizeInfo, PublicConfig } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { AppIcon } from '../../components/Logo.tsx';
import { Spinner } from '../../components/Spinner.tsx';
import { Switch } from '../../components/Switch.tsx';
import { api, call, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';

type State =
  | { step: 'loading' }
  | { step: 'error'; message: string }
  | { step: 'consent'; info: AuthorizeInfo }
  | { step: 'leaving'; host: string; message: string };

async function loadInfo(): Promise<AuthorizeInfo | { redirect: string }> {
  const res = await fetch(`/api/oauth/authorize${window.location.search}`, { credentials: 'same-origin' }).catch(() => null);
  if (!res) throw new Error('网络连接失败，请检查网络');
  const data = (await res.json().catch(() => null)) as (AuthorizeInfo & { error?: string }) | { redirect: string } | null;
  if (!res.ok || !data) throw new Error((data as { error?: string } | null)?.error ?? `请求失败（${res.status}）`);
  return data;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-5 py-12">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 left-1/2 size-[560px] -translate-x-1/2 rounded-full bg-brand-500/18 blur-3xl dark:bg-brand-500/12" />
        <div className="absolute bottom-0 -left-40 size-[420px] rounded-full bg-accent-400/18 blur-3xl dark:bg-accent-500/10" />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', damping: 26, stiffness: 260 }}
        className="w-full max-w-sm"
      >
        {children}
      </motion.div>
    </div>
  );
}

export function AuthorizePage({ config }: { config: PublicConfig }) {
  const [state, setState] = useState<State>({ step: 'loading' });

  useEffect(() => {
    loadInfo().then(
      (info) => {
        if ('redirect' in info) {
          setState({ step: 'leaving', host: new URL(info.redirect).host, message: '授权请求有误，正在返回' });
          window.location.replace(info.redirect);
        } else {
          setState({ step: 'consent', info });
        }
      },
      (err: Error) => setState({ step: 'error', message: err.message }),
    );
  }, []);

  if (state.step === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center text-zinc-400">
        <Spinner className="size-7" />
      </div>
    );
  }

  if (state.step === 'error') {
    return (
      <Shell>
        <div className="card flex flex-col items-center gap-3 p-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-500">
            <TriangleAlert className="size-6" />
          </span>
          <h1 className="text-lg font-semibold">无法完成授权</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{state.message}</p>
          <p className="text-[13px] text-zinc-400">请关闭此页，回到 AI 应用重新连接。</p>
        </div>
      </Shell>
    );
  }

  if (state.step === 'leaving') {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-4 text-center">
          <motion.span
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', damping: 14, stiffness: 260 }}
            className="flex size-16 items-center justify-center rounded-3xl bg-emerald-500/12 text-emerald-500"
          >
            <CircleCheck className="size-8" />
          </motion.span>
          <div>
            <p className="text-lg font-semibold">{state.message}</p>
            <p className="mt-1 flex items-center justify-center gap-1.5 text-sm text-zinc-500">
              <Spinner className="size-3.5" />
              正在返回 {state.host}
            </p>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Consent
      info={state.info}
      config={config}
      onDone={(redirect, message) => {
        setState({ step: 'leaving', host: new URL(redirect).host, message });
        window.location.replace(redirect);
      }}
    />
  );
}

type Target = 'admin' | 'session' | 'code';

function Consent({ info, config, onDone }: { info: AuthorizeInfo; config: PublicConfig; onDone: (redirect: string, message: string) => void }) {
  const shared = config.mode === 'shared';
  const canWrite = info.scopes.includes('ledger:write');
  const [admin, setAdmin] = useState<AdminIdentity | null>(null);
  const [target, setTarget] = useState<Target>(info.session && !shared ? 'session' : 'code');
  const [write, setWrite] = useState(canWrite);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const name = info.client.name || info.client.host || '未知应用';
  const needCode = !shared && target === 'code';

  useEffect(() => {
    if (shared || config.adminAuth === 'disabled') return;
    call(api.admin.me.$get()).then(
      (me) => {
        setAdmin(me);
        setTarget('admin');
      },
      () => undefined,
    );
  }, [shared, config.adminAuth]);

  async function approve(e: FormEvent) {
    e.preventDefault();
    const value = code.trim();
    if (needCode) {
      if (value.length < LIMITS.codeMin) return setError(`口令至少 ${LIMITS.codeMin} 位`);
      if (!/^[a-zA-Z0-9]+$/.test(value)) return setError('口令只能包含字母和数字');
    }
    setLoading(true);
    setError('');
    const query = window.location.search.slice(1);
    try {
      if (target === 'admin') {
        const result = await call(api.admin.oauth.authorize.$post({ json: { query, write } }));
        onDone(result.redirect, '已以管理员身份连接');
      } else {
        const result = await call(api.oauth.authorize.$post({ json: { query, code: needCode ? value : undefined, write } }));
        onDone(result.redirect, result.ledger ? `已连接「${result.ledger.name}」` : '授权请求有误');
      }
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  const targets = [
    admin && { value: 'admin' as const, label: '全部账本' },
    info.session && !shared && { value: 'session' as const, label: `「${info.session.ledger.name}」` },
    (admin || info.session) && !shared && { value: 'code' as const, label: '用口令' },
  ].filter((o): o is { value: Target; label: string } => !!o);

  return (
    <Shell>
      <div className="mb-7 flex flex-col items-center text-center">
        <div className="flex items-center gap-3">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-zinc-800 to-zinc-950 text-white shadow-lg ring-1 ring-white/10 dark:from-white/12 dark:to-white/5">
            <Sparkles className="size-6" />
          </span>
          <ArrowLeftRight className="size-4 text-zinc-400" />
          <AppIcon className="size-14 drop-shadow-[0_8px_16px_rgb(91_92_240/0.3)]" />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight">
          <span className="text-brand-600 dark:text-brand-300">{name}</span> 想要连接你的账本
        </h1>
        <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
          授权后将返回 <span className="font-medium text-zinc-700 dark:text-zinc-200">{info.redirectHost}</span>
        </p>
      </div>

      <form onSubmit={approve} className="card space-y-5 p-5">
        <section>
          <h2 className="mb-2 text-[13px] font-medium text-zinc-500 dark:text-zinc-400">授权的账本</h2>
          {shared ? (
            <p className="rounded-2xl bg-zinc-50 px-4 py-3 text-sm dark:bg-white/4">共享账本</p>
          ) : (
            <div className="space-y-2">
              {targets.length > 1 && (
                <div className="grid gap-1 rounded-2xl bg-zinc-100/80 p-1 dark:bg-white/6" style={{ gridTemplateColumns: `repeat(${targets.length}, minmax(0, 1fr))` }}>
                  {targets.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => {
                        setTarget(o.value);
                        setError('');
                      }}
                      className={cn(
                        'truncate rounded-xl px-2 py-2 text-sm transition',
                        target === o.value ? 'bg-white font-medium shadow-sm dark:bg-white/12' : 'text-zinc-500',
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
              {target === 'admin' && admin && (
                <p className="flex items-center gap-2 rounded-2xl bg-brand-500/8 px-4 py-3 text-[13px] text-brand-700 dark:text-brand-200">
                  <ShieldCheck className="size-4 shrink-0" />
                  <span className="min-w-0">
                    以管理员 <span className="font-medium break-all">{admin.name}</span> 的身份授权，可管理全部账本
                  </span>
                </p>
              )}
              {needCode && (
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-zinc-400" />
                  <input
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value);
                      setError('');
                    }}
                    maxLength={LIMITS.codeMax}
                    placeholder="输入账本的分享口令"
                    autoFocus
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="field pl-10 font-mono tracking-wider"
                  />
                </div>
              )}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-[13px] font-medium text-zinc-500 dark:text-zinc-400">将获得的权限</h2>
          <ul className="divide-y divide-zinc-900/5 rounded-2xl bg-zinc-50 dark:divide-white/5 dark:bg-white/4">
            <li className="flex items-center gap-3 px-4 py-3">
              <Eye className="size-4 shrink-0 text-brand-500" />
              <span className="flex-1 text-sm">{target === 'admin' ? '查看全部账本、口令与账目' : '查看成员、支出、余额与结算'}</span>
              <Check className="size-4 text-emerald-500" />
            </li>
            {canWrite && (
              <li className="flex items-center gap-3 px-4 py-3">
                <PenLine className={cn('size-4 shrink-0', write ? 'text-brand-500' : 'text-zinc-400')} />
                <span className={cn('flex-1 text-sm', !write && 'text-zinc-400')}>
                  {target === 'admin' ? '记账，以及创建 / 删除账本、管理口令' : '记账、修改与删除账目'}
                </span>
                <Switch checked={write} onChange={setWrite} label="允许修改" />
              </li>
            )}
          </ul>
        </section>

        {error && <p className="text-center text-sm text-rose-500">{error}</p>}

        <div className="space-y-2">
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
            允许连接
          </Button>
          <Button variant="ghost" className="w-full" disabled={loading} onClick={() => onDone(info.denyUrl, '已取消授权')}>
            取消
          </Button>
        </div>
      </form>

      {!admin && info.adminLoginUrl && (
        <button
          type="button"
          onClick={() => window.location.assign(info.adminLoginUrl!)}
          className="mx-auto mt-5 flex items-center gap-1.5 text-sm text-zinc-500 transition hover:text-brand-600 dark:text-zinc-400"
        >
          <ShieldCheck className="size-4" />
          以管理员身份登录，授权管理全部账本
        </button>
      )}

      <p className="mt-5 px-2 text-center text-xs leading-relaxed text-zinc-400 dark:text-zinc-500">
        {target === 'admin'
          ? '应用名称由对方自行声明，请确认跳转地址是你信任的应用。管理员授权 30 天内有效，可随时在账本页的「连接 AI」中断开；关闭管理后台或移出管理员名单后立即失效。'
          : '应用名称由对方自行声明，请确认跳转地址是你信任的应用。授权只对这一个账本有效，可随时在账本的「连接 AI」中断开；口令被撤销时也会自动失效。'}
      </p>
    </Shell>
  );
}
