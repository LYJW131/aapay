import { KeyRound, LogOut, ShieldAlert } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { localPath } from '../../../shared/redirect.ts';
import type { AdminIdentity, PublicConfig } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { LanguageSwitch } from '../../components/LanguageSwitch.tsx';
import { AppIcon } from '../../components/Logo.tsx';
import { Spinner } from '../../components/Spinner.tsx';
import { admin as t } from '../../i18n/admin.ts';
import { api, call, errorMessage } from '../../lib/api.ts';

export function AdminPage({ config, admin }: { config: PublicConfig; admin: AdminIdentity | null }) {
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const back = localPath(params.get('return_to'));
  const external = config.adminAuth === 'access' || config.adminAuth === 'proxy' || config.adminAuth === 'none';
  const redirecting = !!admin || (external && params.get('error') !== 'denied');

  useEffect(() => {
    document.title = t.login.documentTitle;
    if (admin) window.location.replace(back);
    else if (redirecting) window.location.replace(`/api/admin/login?return_to=${encodeURIComponent(back)}`);
  }, [admin, redirecting, back]);

  if (redirecting) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-zinc-400">
        <Spinner className="size-7" />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-5">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-4 text-center">
          <AppIcon className="size-16" />
          <h1 className="text-xl font-semibold tracking-tight">{t.login.title}</h1>
        </div>
        {config.adminAuth === 'password' ? (
          <LoginForm onDone={() => window.location.replace(back)} />
        ) : config.adminAuth === 'access' ? (
          <Notice title={t.login.notAdminTitle}>
            {t.login.notAdminBody}
            <Button variant="primary" className="mt-4 w-full" icon={<LogOut className="size-4" />} onClick={() => window.location.assign('/cdn-cgi/access/logout')}>
              {t.login.accessLogout}
            </Button>
          </Notice>
        ) : config.adminAuth === 'proxy' ? (
          <Notice title={t.login.deniedTitle}>{t.login.deniedBody}</Notice>
        ) : (
          <Notice title={t.login.disabledTitle}>
            {t.login.disabledBefore}
            <code className="font-mono">ADMIN_AUTH</code>
            {t.login.disabledAfter}
          </Notice>
        )}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          <button onClick={() => window.location.assign('/')} className="text-sm text-zinc-500 hover:text-brand-600">
            {t.login.backHome}
          </button>
          <LanguageSwitch />
        </div>
      </div>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-5 text-center">
      <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-amber-500/12 text-amber-600">
        <ShieldAlert className="size-5" />
      </div>
      <p className="font-medium">{title}</p>
      <div className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{children}</div>
    </div>
  );
}

function LoginForm({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await call(api.admin.login.$post({ json: { password } }));
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-3 p-5">
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={t.login.password}
        autoFocus
        autoComplete="current-password"
        className="field"
      />
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading} icon={<KeyRound className="size-4" />}>
        {t.login.submit}
      </Button>
    </form>
  );
}
