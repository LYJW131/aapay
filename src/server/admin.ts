import type { LedgerInfo, LedgerOverview, Passphrase } from '../shared/types.ts';
import type { Platform } from './platform.ts';

/**
 * 管理操作中需要同时处理注册表与账本的部分，管理控制台接口与 MCP 管理员工具共用：
 * 重命名要通知在线成员，删除要销毁账本数据，撤销口令要断开用它登录的连接。
 */
export function adminActions(platform: Platform) {
  return {
    async listLedgers(): Promise<LedgerOverview[]> {
      const ledgers = await platform.registry.listLedgers();
      const stats = await Promise.all(ledgers.map((l) => platform.ledger(l.id).api.stats().catch(() => null)));
      return ledgers.map((l, i) => ({ ...l, stats: stats[i] ?? null }));
    },

    async renameLedger(id: string, name: string): Promise<LedgerInfo> {
      const ledger = await platform.registry.renameLedger(id, name);
      await platform.ledger(ledger.id).api.notify({ type: 'ledger.renamed', name: ledger.name });
      return ledger;
    },

    async deleteLedger(id: string): Promise<LedgerInfo> {
      const ledger = await platform.registry.deleteLedger(id);
      await platform.ledger(ledger.id).destroy();
      return ledger;
    },

    async revokePassphrase(id: string): Promise<Passphrase> {
      const passphrase = await platform.registry.revokePassphrase(id);
      await platform.ledger(passphrase.ledgerId).disconnect(`p:${passphrase.code.toLowerCase()}`);
      return passphrase;
    },
  };
}
