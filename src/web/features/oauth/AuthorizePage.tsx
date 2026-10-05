import { ArrowLeftRight, Check, CircleCheck, Eye, KeyRound, PenLine, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { LIMITS } from '../../../shared/limits.ts';
import type { AdminIdentity, AuthorizeInfo, PublicConfig } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { Hint } from '../../components/Hint.tsx';
import { LanguageSwitch } from '../../components/LanguageSwitch.tsx';
import { AppIcon } from '../../components/Logo.tsx';
import { Spinner } from '../../components/Spinner.tsx';
import { Switch } from '../../components/Switch.tsx';
import { common } from '../../i18n/common.ts';
import { locale } from '../../i18n/locale.ts';
import { oauth as t } from '../../i18n/oauth.ts';
import { api, call, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';

type State =
  | { step: 'loading' }
  | { step: 'error'; message: string }
  | { step: 'consent'; info: AuthorizeInfo }
  | { step: 'leaving'; host: string; message: string };

async function loadInfo(): Promise<AuthorizeInfo | { redirect: string }> {
  const res = await fetch(`/api/oauth/authorize${window.location.search}`, {
    credentials: 'same-origin',
    headers: { 'accept-language': locale },
  }).catch(() => null);
  if (!res) throw new Error(common.networkError);
  const data = (await res.json().catch(() => null)) as (AuthorizeInfo & { error?: string }) | { redirect: string } | null;
  if (!res.ok || !data) throw new Error((data as { error?: string } | null)?.error ?? common.requestFailed(res.status));
  return data;
}

function Shell({ children, languageSwitch = false }: { children: ReactNode; languageSwitch?: boolean }) {
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
      {languageSwitch && <LanguageSwitch className="mt-8" />}
    </div>
  );
}

export function AuthorizePage({ config, admin }: { config: PublicConfig; admin: AdminIdentity | null }) {
  const [state, setState] = useState<State>({ step: 'loading' });

  useEffect(() => {
    loadInfo().then(
      (info) => {
        if ('redirect' in info) {
          setState({ step: 'leaving', host: new URL(info.redirect).host, message: t.returning });
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
      <Shell languageSwitch>
        <div className="card flex flex-col items-center gap-3 p-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-500">
            <TriangleAlert className="size-6" />
          </span>
          <h1 className="text-lg font-semibold">{t.errorTitle}</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{state.message}</p>
          <p className="text-[13px] text-zinc-400">{t.errorHint}</p>
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
              {t.returningTo(state.host)}
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
      admin={admin}
      onDone={(redirect, message) => {
        setState({ step: 'leaving', host: new URL(redirect).host, message });
        window.location.replace(redirect);
      }}
    />
  );
}

type Target = 'admin' | 'session' | 'code';

function Consent({
  info,
  config,
  admin,
  onDone,
}: {
  info: AuthorizeInfo;
  config: PublicConfig;
  admin: AdminIdentity | null;
  onDone: (redirect: string, message: string) => void;
}) {
  const shared = config.mode === 'shared';
  const canWrite = info.scopes.includes('ledger:write');
  const [target, setTarget] = useState<Target>(admin && !shared ? 'admin' : info.session && !shared ? 'session' : 'code');
  const [write, setWrite] = useState(canWrite);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const name = info.client.name || info.client.host || t.unknownApp;
  const needCode = !shared && target === 'code';

  async function approve(e: FormEvent) {
    e.preventDefault();
    const value = code.trim();
    if (needCode) {
      if (value.length < LIMITS.codeMin) return setError(t.codeTooShort(LIMITS.codeMin));
      if (!/^[a-zA-Z0-9]+$/.test(value)) return setError(t.codeInvalid);
    }
    setLoading(true);
    setError('');
    const query = window.location.search.slice(1);
    try {
      if (target === 'admin') {
        const result = await call(api.admin.oauth.authorize.$post({ json: { query, write } }));
        onDone(result.redirect, t.connectedAsAdmin);
      } else {
        const result = await call(api.oauth.authorize.$post({ json: { query, code: needCode ? value : undefined, write } }));
        onDone(result.redirect, result.ledger ? t.connectedLedger(result.ledger.name) : t.invalidRequest);
      }
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  const targets = [
    admin && { value: 'admin' as const, label: t.targets.admin },
    info.session && !shared && { value: 'session' as const, label: t.targets.session(info.session.ledger.name) },
    (admin || info.session) && !shared && { value: 'code' as const, label: t.targets.code },
  ].filter((o): o is { value: Target; label: string } => !!o);

  return (
    <Shell languageSwitch>
      <div className="mb-7 flex flex-col items-center text-center">
        <div className="flex items-center gap-3">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-zinc-800 to-zinc-950 text-white shadow-lg ring-1 ring-white/10 dark:from-white/12 dark:to-white/5">
            <Sparkles className="size-6" />
          </span>
          <ArrowLeftRight className="size-4 text-zinc-400" />
          <AppIcon className="size-14 drop-shadow-[0_8px_16px_rgb(91_92_240/0.3)]" />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight">
          <span className="text-brand-600 dark:text-brand-300">{name}</span> {t.wantsToConnect}
        </h1>
        <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
          {t.redirectBefore} <span className="font-medium text-zinc-700 dark:text-zinc-200">{info.redirectHost}</span>
        </p>
      </div>

      <form onSubmit={approve} className="card space-y-5 p-5">
        <section>
          <h2 className="mb-2 text-[13px] font-medium text-zinc-500 dark:text-zinc-400">{t.ledgerSection}</h2>
          {shared ? (
            <p className="rounded-2xl bg-zinc-50 px-4 py-3 text-sm dark:bg-white/4">{t.sharedLedger}</p>
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
                    {t.adminBefore} <span className="font-medium break-all">{admin.name}</span> {t.adminAfter}
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
                    placeholder={t.codePlaceholder}
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
          <h2 className="mb-2 text-[13px] font-medium text-zinc-500 dark:text-zinc-400">{t.permissionsSection}</h2>
          <ul className="divide-y divide-zinc-900/5 rounded-2xl bg-zinc-50 dark:divide-white/5 dark:bg-white/4">
            <li className="flex items-center gap-3 px-4 py-3">
              <Eye className="size-4 shrink-0 text-brand-500" />
              <span className="flex-1 text-sm">{target === 'admin' ? t.readAdmin : t.readLedger}</span>
              <Check className="size-4 text-emerald-500" />
            </li>
            {canWrite && (
              <li className="flex items-center gap-3 px-4 py-3">
                <PenLine className={cn('size-4 shrink-0', write ? 'text-brand-500' : 'text-zinc-400')} />
                <span className={cn('flex-1 text-sm', !write && 'text-zinc-400')}>
                  {target === 'admin' ? t.writeAdmin : t.writeLedger}
                </span>
                <Switch checked={write} onChange={setWrite} label={t.allowWrite} />
              </li>
            )}
          </ul>
        </section>

        {error && <p className="text-center text-sm text-rose-500">{error}</p>}

        <div className="space-y-2">
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
            {t.approve}
          </Button>
          <Button variant="ghost" className="w-full" disabled={loading} onClick={() => onDone(info.denyUrl, t.cancelled)}>
            {t.cancel}
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
          {t.adminLogin}
        </button>
      )}

      <p className="mt-5 flex items-center justify-center gap-1.5 px-2 text-xs text-zinc-400 dark:text-zinc-500">
        {target === 'admin' ? t.noteAdmin : t.noteLedger}
        <Hint>{target === 'admin' ? t.detailAdmin : t.detailLedger}</Hint>
      </p>
    </Shell>
  );
}
