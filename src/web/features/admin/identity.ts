import type { AdminIdentity, PublicConfig, SessionInfo } from '../../../shared/types.ts';
import { api, ApiError, call } from '../../lib/api.ts';
import { load, save } from '../../lib/storage.ts';

// 有这个标记才去检查管理员身份，普通访客不会请求管理接口
export const ADMIN_HINT = 'aapay:admin';

export async function detectAdmin(config: PublicConfig, session: SessionInfo | null): Promise<AdminIdentity | null> {
  if (config.mode === 'shared' || config.adminAuth === 'disabled') return null;
  if (session?.role !== 'admin' && !load(ADMIN_HINT, false)) return null;
  try {
    return await call(api.admin.me.$get());
  } catch (err) {
    // Access 登录过期时请求会被重定向成网络错误，这种情况保留标记
    if (err instanceof ApiError && err.status >= 400) save(ADMIN_HINT, false);
    return null;
  }
}
