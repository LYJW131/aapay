import { KeyRound, LockKeyhole, RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { PublicConfig } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { AppIcon } from '../../components/Logo.tsx';
import { Spinner } from '../../components/Spinner.tsx';
import { api, ApiError, call, errorMessage } from '../../lib/api.ts';
import { save } from '../../lib/storage.ts';
import { ADMIN_HINT } from './identity.ts';

type Gate = { state: 'loading' } | { state: 'denied' } | { state: 'disabled' };

/**
 * /admin 只是管理员登录入口（Cloudflare Access 会拦截这个路径）：
 * 认证通过后回到首页，管理功能以卡片形式嵌在账本页顶部。
 * 从 AI 授权页过来的，登录后回到授权页（只允许站内授权页地址，避免开放跳转）。
 */
export function AdminPage({ config }: { config: PublicConfig }) {
  const [gate, setGate] = useState<Gate>({ state: 'loading' });

  const check = useCallback(async () => {
    try {
      await call(api.admin.me.$get());
      save(ADMIN_HINT, true);
      const returnTo = new URLSearchParams(window.location.search).get('return_to');
      window.location.replace(returnTo?.startsWith('/oauth/authorize?') ? returnTo : '/');
    } catch (err) {
      setGate({ state: err instanceof ApiError && err.status === 404 ? 'disabled' : 'denied' });
    }
  }, []);

  useEffect(() => {
    document.title = '管理员登录 · AAPay';
    void check();
  }, [check]);

  if (gate.state === 'loading') {
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
          <h1 className="text-xl font-semibold tracking-tight">AAPay 管理员登录</h1>
        </div>
        {gate.state === 'disabled' ? (
          <Notice icon={<ShieldAlert />} title="管理后台未启用">
            设置环境变量 <code className="font-mono">ADMIN_AUTH</code> 以启用（见 README）。
          </Notice>
        ) : config.adminAuth === 'password' ? (
          <LoginForm onDone={check} />
        ) : config.adminAuth === 'access' ? (
          <Notice icon={<LockKeyhole />} title="需要通过 Cloudflare Access 登录">
            你的登录状态已失效或账号无权访问。
            <Button variant="primary" className="mt-4 w-full" icon={<RefreshCw className="size-4" />} onClick={() => window.location.reload()}>
              重新登录
            </Button>
          </Notice>
        ) : (
          <Notice icon={<ShieldAlert />} title="无权访问">
            未从上游代理获得允许的管理员身份。
          </Notice>
        )}
        <button onClick={() => window.location.assign('/')} className="mx-auto mt-6 block text-sm text-zinc-500 hover:text-brand-600">
          返回首页
        </button>
      </div>
    </div>
  );
}

function Notice({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="card p-5 text-center">
      <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-amber-500/12 text-amber-600 [&>svg]:size-5">{icon}</div>
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
        placeholder="管理员密码"
        autoFocus
        autoComplete="current-password"
        className="field"
      />
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading} icon={<KeyRound className="size-4" />}>
        登录
      </Button>
    </form>
  );
}
