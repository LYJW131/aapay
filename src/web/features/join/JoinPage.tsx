import { ArrowRight, ShieldCheck } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LIMITS } from '../../../shared/limits.ts';
import type { PublicConfig, SessionInfo } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { Collapse } from '../../components/Collapse.tsx';
import { LanguageSwitch } from '../../components/LanguageSwitch.tsx';
import { AppIcon } from '../../components/Logo.tsx';
import { join as t } from '../../i18n/join.ts';
import { api, call, errorMessage } from '../../lib/api.ts';
import { navigate } from '../../lib/router.ts';

function codeFromUrl() {
  const hash = decodeURIComponent(window.location.hash.slice(1));
  return window.location.pathname === '/join' && hash ? hash : null;
}

export function JoinPage({ config, notice, onJoined }: { config: PublicConfig; notice?: string; onJoined: (s: SessionInfo, welcome?: boolean) => Promise<void> }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState(notice ?? '');
  const [loading, setLoading] = useState(false);
  const auto = useRef(false);

  async function join(value: string, fromLink = false) {
    setLoading(true);
    try {
      const session = await call(api.join.$post({ json: { code: value } }));
      await onJoined(session, fromLink);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  useEffect(() => {
    const fromUrl = codeFromUrl();
    if (!fromUrl || auto.current) return;
    auto.current = true;
    history.replaceState(null, '', '/');
    setCode(fromUrl);
    void join(fromUrl, true);
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = code.trim();
    if (value.length < LIMITS.codeMin) return setError(t.tooShort(LIMITS.codeMin));
    if (!/^[a-zA-Z0-9]+$/.test(value)) return setError(t.invalidChars);
    void join(value);
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-5 py-12">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 left-1/2 size-[560px] -translate-x-1/2 rounded-full bg-brand-500/20 blur-3xl dark:bg-brand-500/15" />
        <div className="absolute top-1/3 -right-40 size-[420px] rounded-full bg-accent-400/20 blur-3xl dark:bg-accent-500/10" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', damping: 26, stiffness: 260 }}
        className="w-full max-w-sm"
      >
        <div className="mb-8 flex flex-col items-center text-center">
          <AppIcon className="size-20 drop-shadow-[0_12px_24px_rgb(91_92_240/0.35)]" />
          <h1 className="mt-6 text-3xl font-semibold tracking-tight">
            <span className="bg-gradient-to-br from-brand-500 to-accent-500 bg-clip-text text-transparent">AA</span>Pay
          </h1>
          <p className="mt-2 text-[15px] text-zinc-500 dark:text-zinc-400">{t.tagline}</p>
        </div>

        <form onSubmit={submit} className="card space-y-3 p-5">
          <label htmlFor="code" className="block text-sm font-medium text-zinc-600 dark:text-zinc-300">
            {t.label}
          </label>
          <div>
            <input
              id="code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setError('');
              }}
              maxLength={LIMITS.codeMax}
              placeholder={t.placeholder}
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="field h-13 text-center font-mono text-lg tracking-[0.25em]"
            />
            <Collapse open={!!error} className="pt-3">
              <p className="text-center text-sm text-rose-500">{error}</p>
            </Collapse>
          </div>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading} disabled={code.trim().length < LIMITS.codeMin}>
            {t.submit}
            <ArrowRight className="size-4" />
          </Button>
        </form>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {config.adminAuth !== 'disabled' && (
            <button
              onClick={() => window.location.assign('/admin')}
              className="flex items-center gap-1.5 text-sm text-zinc-500 transition hover:text-brand-600 dark:text-zinc-400"
            >
              <ShieldCheck className="size-4" />
              {t.admin}
            </button>
          )}
          <LanguageSwitch />
        </div>
      </motion.div>
    </div>
  );
}
