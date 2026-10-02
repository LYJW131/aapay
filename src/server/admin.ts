import type { LedgerInfo, LedgerOverview, Passphrase } from '../shared/types.ts';
import type { Platform } from './platform.ts';

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
