import type { LedgerOverview, Passphrase } from '../../../shared/types.ts';
import { api, call } from '../../lib/api.ts';

type Modules = {
  AdminCard: (typeof import('./AdminCard.tsx'))['AdminCard'];
  AdminHome: (typeof import('./AdminHome.tsx'))['AdminHome'];
};

let modules: Modules | null = null;

export const adminCache = {
  ledgers: null as LedgerOverview[] | null,
  passphrases: new Map<string, Passphrase[]>(),
};

export const adminModules = () => modules;

export async function preloadAdmin(ledgerId: string | null) {
  await Promise.all([
    modules ??
      Promise.all([import('./AdminCard.tsx'), import('./AdminHome.tsx')]).then(([card, home]) => {
        modules = { AdminCard: card.AdminCard, AdminHome: home.AdminHome };
      }),
    prefetchAdminData(ledgerId),
  ]);
}

export async function prefetchAdminData(ledgerId: string | null) {
  try {
    const [ledgers, passphrases] = await Promise.all([
      call(api.admin.ledgers.$get()),
      ledgerId ? call(api.admin.ledgers[':id'].passphrases.$get({ param: { id: ledgerId } })) : null,
    ]);
    adminCache.ledgers = ledgers;
    if (ledgerId && passphrases) adminCache.passphrases.set(ledgerId, passphrases);
  } catch {
    // 预取失败不影响页面：卡片挂载后会自己重新加载
  }
}
