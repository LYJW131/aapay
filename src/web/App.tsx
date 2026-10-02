import { lazy, Suspense, useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import type { PublicConfig, SessionInfo } from '../shared/types.ts';
import { Spinner } from './components/Spinner.tsx';
import { JoinPage } from './features/join/JoinPage.tsx';
import { LedgerPage } from './features/ledger/LedgerPage.tsx';
import { api, call } from './lib/api.ts';
import { useMediaQuery } from './lib/hooks.ts';
import { usePathname } from './lib/router.ts';

const AdminPage = lazy(() => import('./features/admin/AdminPage.tsx').then((m) => ({ default: m.AdminPage })));

type Boot =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; config: PublicConfig; session: SessionInfo | null; notice?: string };

async function boot(): Promise<Boot> {
  // 带着口令链接进来时，先展示加入页，由它完成加入
  const joining = window.location.pathname === '/join';
  const config = await call(api.config.$get());
  if (joining) return { state: 'ready', config, session: null };
  return { state: 'ready', config, session: await call(api.session.$get()) };
}

export function App() {
  const pathname = usePathname();
  const [app, setApp] = useState<Boot>({ state: 'loading' });
  const dark = useMediaQuery('(prefers-color-scheme: dark)');

  useEffect(() => {
    let cancelled = false;
    boot().then(
      (result) => !cancelled && setApp(result),
      (err: Error) => !cancelled && setApp({ state: 'error', message: err.message }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  let page;
  if (app.state === 'loading') {
    page = (
      <div className="flex min-h-dvh items-center justify-center text-zinc-400">
        <Spinner className="size-7" />
      </div>
    );
  } else if (app.state === 'error') {
    page = (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center text-sm text-zinc-500">
        <p>{app.message}</p>
        <button className="text-brand-600 underline" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    );
  } else if (pathname.startsWith('/admin')) {
    page = (
      <Suspense fallback={<div className="flex min-h-dvh items-center justify-center text-zinc-400"><Spinner className="size-7" /></div>}>
        <AdminPage config={app.config} />
      </Suspense>
    );
  } else if (app.session) {
    page = (
      <LedgerPage
        key={app.session.ledger.id}
        session={app.session}
        config={app.config}
        onExit={(notice) => setApp({ ...app, session: null, notice })}
      />
    );
  } else {
    page = <JoinPage config={app.config} notice={app.notice} onJoined={(session) => setApp({ ...app, session, notice: undefined })} />;
  }

  return (
    <>
      {page}
      <Toaster
        position="top-center"
        theme={dark ? 'dark' : 'light'}
        offset={{ top: 'max(16px, env(safe-area-inset-top))' }}
        toastOptions={{ classNames: { toast: 'rounded-2xl! font-sans! shadow-lg!' } }}
      />
    </>
  );
}
