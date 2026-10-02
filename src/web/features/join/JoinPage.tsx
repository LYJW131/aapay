import { ArrowRight, ShieldCheck } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LIMITS } from '../../../shared/limits.ts';
import type { PublicConfig, SessionInfo } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { AppIcon } from '../../components/Logo.tsx';
import { api, call, errorMessage } from '../../lib/api.ts';
import { navigate } from '../../lib/router.ts';

/** 从 /join#口令（或旧版 /#p=口令）链接中读取口令 */
function codeFromUrl() {
  const hash = decodeURIComponent(window.location.hash.slice(1));
  if (window.location.pathname === '/join' && hash) return hash;
  if (hash.startsWith('p=')) return hash.slice(2);
  return null;
}

export function JoinPage({ config, notice, onJoined }: { config: PublicConfig; notice?: string; onJoined: (s: SessionInfo) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState(notice ?? '');
  const [loading, setLoading] = useState(false);
  const auto = useRef(false);

  async function join(value: string) {
    setLoading(true);
    setError('');
    try {
      const session = await call(api.join.$post({ json: { code: value } }));
      navigate('/', { replace: true });
      onJoined(session);
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
    void join(fromUrl);
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = code.trim();
    if (value.length < LIMITS.codeMin) return setError(`口令至少 ${LIMITS.codeMin} 位`);
    if (!/^[a-zA-Z0-9]+$/.test(value)) return setError('口令只能包含字母和数字');
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
          <p className="mt-2 text-[15px] text-zinc-500 dark:text-zinc-400">一起花钱，轻松算账</p>
        </div>

        <form onSubmit={submit} className="card space-y-3 p-5">
          <label htmlFor="code" className="block text-sm font-medium text-zinc-600 dark:text-zinc-300">
            输入分享口令加入账本
          </label>
          <input
            id="code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError('');
            }}
            maxLength={LIMITS.codeMax}
            placeholder="口令"
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="field h-13 text-center font-mono text-lg tracking-[0.25em]"
          />
          {error && <p className="text-center text-sm text-rose-500">{error}</p>}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading} disabled={code.trim().length < LIMITS.codeMin}>
            进入账本
            {!loading && <ArrowRight className="size-4" />}
          </Button>
        </form>

        {config.adminAuth !== 'disabled' && (
          <button
            onClick={() => window.location.assign('/admin')}
            className="mx-auto mt-6 flex items-center gap-1.5 text-sm text-zinc-500 transition hover:text-brand-600 dark:text-zinc-400"
          >
            <ShieldCheck className="size-4" />
            管理员入口
          </button>
        )}
      </motion.div>
    </div>
  );
}
