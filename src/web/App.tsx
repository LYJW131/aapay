import { lazy, Suspense, useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import type { AdminIdentity, PublicConfig, SessionInfo } from '../shared/types.ts';
import { Spinner } from './components/Spinner.tsx';
import { detectAdmin } from './features/admin/identity.ts';
import { JoinPage } from './features/join/JoinPage.tsx';
import { LedgerPage } from './features/ledger/LedgerPage.tsx';
import { api, call } from './lib/api.ts';
import { useMediaQuery } from './lib/hooks.ts';
import { usePathname } from './lib/router.ts';

const AdminPage = lazy(() => import('./features/admin/AdminPage.tsx').then((m) => ({ default: m.AdminPage })));
const AdminHome = lazy(() => import('./features/admin/AdminHome.tsx').then((m) => ({ default: m.AdminHome })));
const AuthorizePage = lazy(() => import('./features/oauth/AuthorizePage.tsx').then((m) => ({ default: m.AuthorizePage })));

type Boot =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; config: PublicConfig; session: SessionInfo | null; admin: AdminIdentity | null; notice?: string };

async function boot(): Promise<Boot> {
  // 这些页面自己处理登录状态，不在这里拉会话
  const { pathname } = window.location;
  const config = await call(api.config.$get());
  if (pathname === '/join' || pathname === '/oauth/authorize' || pathname.startsWith('/admin')) {
    return { state: 'ready', config, session: null, admin: null };
  }
  const session = await call(api.session.$get());
  return { state: 'ready', config, session, admin: await detectAdmin(config, session) };
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
  } else if (pathname === '/oauth/authorize') {
    page = (
      <Suspense fallback={<div className="flex min-h-dvh items-center justify-center text-zinc-400"><Spinner className="size-7" /></div>}>
        <AuthorizePage config={app.config} />
      </Suspense>
    );
  } else if (app.session) {
    page = (
      <LedgerPage
        key={app.session.ledger.id}
        session={app.session}
        config={app.config}
        admin={app.admin}
        onSwitch={(session) => setApp({ ...app, session })}
        onExit={(notice) => setApp({ ...app, session: null, notice })}
      />
    );
  } else if (app.admin) {
    page = (
      <Suspense fallback={<div className="flex min-h-dvh items-center justify-center text-zinc-400"><Spinner className="size-7" /></div>}>
        <AdminHome admin={app.admin} notice={app.notice} onEnter={(session) => setApp({ ...app, session, notice: undefined })} />
      </Suspense>
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
