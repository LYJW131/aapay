import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import type { AdminIdentity, PublicConfig, SessionInfo, Snapshot } from '../shared/types.ts';
import { Spinner } from './components/Spinner.tsx';
import { adminModules, preloadAdmin, prefetchAdminData } from './features/admin/preload.ts';
import { JoinPage } from './features/join/JoinPage.tsx';
import { LedgerPage } from './features/ledger/LedgerPage.tsx';
import { api, ApiError, call, onAdminExpired } from './lib/api.ts';
import { useDelayed, useMediaQuery } from './lib/hooks.ts';
import { usePathname } from './lib/router.ts';

const AdminPage = lazy(() => import('./features/admin/AdminPage.tsx').then((m) => ({ default: m.AdminPage })));
const AuthorizePage = lazy(() => import('./features/oauth/AuthorizePage.tsx').then((m) => ({ default: m.AuthorizePage })));
const LazyAdminHome = lazy(() => import('./features/admin/AdminHome.tsx').then((m) => ({ default: m.AdminHome })));

type Ready = {
  state: 'ready';
  config: PublicConfig;
  session: SessionInfo | null;
  snapshot: Snapshot | null;
  admin: AdminIdentity | null;
  adminExpired?: boolean;
  notice?: string;
  welcome?: boolean;
};
type Boot = { state: 'loading' } | { state: 'error'; message: string } | Ready;

async function loadSnapshot(): Promise<Snapshot | null> {
  try {
    return await call(api.ledger.$get());
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

async function boot(): Promise<Ready> {
  const { pathname } = window.location;
  const standalone = pathname === '/join' || pathname === '/oauth/authorize' || pathname.startsWith('/admin');
  const [config, { session, admin }] = await Promise.all([call(api.config.$get()), call(api.session.$get())]);
  if (standalone) return { state: 'ready', config, session: null, snapshot: null, admin };
  const [snapshot] = await Promise.all([session ? loadSnapshot() : null, admin ? preloadAdmin(session?.ledger.id ?? null) : null]);
  return { state: 'ready', config, session: snapshot ? session : null, snapshot, admin };
}

function Pending() {
  const visible = useDelayed(true, 300);
  return <div className="flex min-h-dvh items-center justify-center text-zinc-400">{visible && <Spinner className="size-7" />}</div>;
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

  useEffect(
    () =>
      onAdminExpired(() =>
        setApp((a) => {
          if (a.state !== 'ready' || !a.admin) return a;
          if (a.session && a.session.role !== 'admin') return { ...a, admin: null, adminExpired: true };
          return { ...a, admin: null, session: null, snapshot: null, notice: '管理员登录已过期，请重新登录' };
        }),
      ),
    [],
  );

  const open = useCallback(async (session: SessionInfo, welcome = false) => {
    const [snapshot] = await Promise.all([
      call(api.ledger.$get()),
      app.state === 'ready' && app.admin ? prefetchAdminData(session.ledger.id) : null,
    ]);
    setApp((a) => (a.state === 'ready' ? { ...a, session, snapshot, notice: undefined, welcome } : a));
  }, [app]);

  let page;
  if (app.state === 'loading') {
    page = <Pending />;
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
      <Suspense fallback={<Pending />}>
        <AdminPage config={app.config} admin={app.admin} />
      </Suspense>
    );
  } else if (pathname === '/oauth/authorize') {
    page = (
      <Suspense fallback={<Pending />}>
        <AuthorizePage config={app.config} admin={app.admin} />
      </Suspense>
    );
  } else if (app.session && app.snapshot) {
    page = (
      <LedgerPage
        key={app.session.ledger.id}
        session={app.session}
        initialSnapshot={app.snapshot}
        welcome={!!app.welcome}
        config={app.config}
        admin={app.admin}
        adminExpired={!!app.adminExpired}
        onSwitch={open}
        onExit={(notice) => setApp({ ...app, session: null, snapshot: null, notice })}
      />
    );
  } else if (pathname === '/join' || !app.admin) {
    page = <JoinPage config={app.config} notice={app.notice} onJoined={open} />;
  } else {
    const AdminHome = adminModules()?.AdminHome ?? LazyAdminHome;
    page = (
      <Suspense fallback={<Pending />}>
        <AdminHome admin={app.admin} notice={app.notice} onEnter={open} />
      </Suspense>
    );
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
