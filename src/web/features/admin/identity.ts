import type { AdminIdentity, PublicConfig, SessionInfo } from '../../../shared/types.ts';
import { api, ApiError, call } from '../../lib/api.ts';
import { load, save } from '../../lib/storage.ts';

/** 管理员身份的本地标记：有它才在首页检查管理员身份，普通访客不会去请求管理接口 */
export const ADMIN_HINT = 'aapay:admin';

/** 当前浏览器是否是已登录的管理员（与 /admin 入口使用同一套认证） */
export async function detectAdmin(config: PublicConfig, session: SessionInfo | null): Promise<AdminIdentity | null> {
  if (config.mode === 'shared' || config.adminAuth === 'disabled') return null;
  if (session?.role !== 'admin' && !load(ADMIN_HINT, false)) return null;
  try {
    return await call(api.admin.me.$get());
  } catch (err) {
    // 明确被拒绝时清掉标记；网络错误（如 Access 登录过期被重定向）保留，下次再试
    if (err instanceof ApiError && err.status >= 400) save(ADMIN_HINT, false);
    return null;
  }
}
