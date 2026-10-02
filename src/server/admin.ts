import type { AuditActor } from '../shared/audit.ts';
import type { PassphraseInput } from '../shared/schema.ts';
import type { LedgerInfo, LedgerOverview, LedgerRecord, Passphrase } from '../shared/types.ts';
import type { Platform } from './platform.ts';

export function adminActions(platform: Platform, actor: AuditActor) {
  return {
    async listLedgers(): Promise<LedgerOverview[]> {
      const ledgers = await platform.registry.listLedgers();
      const stats = await Promise.all(ledgers.map((l) => platform.ledger(l.id).api.stats().catch(() => null)));
      return ledgers.map((l, i) => ({ ...l, stats: stats[i] ?? null }));
    },

    async createLedger(name: string): Promise<LedgerRecord> {
      const ledger = await platform.registry.createLedger(name);
      await platform.ledger(ledger.id).api.record(actor, { type: 'ledger.create', name: ledger.name });
      return ledger;
    },

    async renameLedger(id: string, name: string): Promise<LedgerInfo> {
      const before = await platform.registry.getLedger(id);
      const ledger = await platform.registry.renameLedger(id, name);
      const api = platform.ledger(ledger.id).api;
      await api.record(actor, { type: 'ledger.rename', from: before.name, to: ledger.name });
      await api.notify({ type: 'ledger.renamed', name: ledger.name });
      return ledger;
    },

    async deleteLedger(id: string): Promise<LedgerInfo> {
      const ledger = await platform.registry.deleteLedger(id);
      await platform.ledger(ledger.id).destroy();
      return ledger;
    },

    async createPassphrase(ledgerId: string, input: PassphraseInput): Promise<Passphrase> {
      const passphrase = await platform.registry.createPassphrase(ledgerId, input);
      await platform.ledger(ledgerId).api.record(actor, { type: 'passphrase.create', code: passphrase.code, validUntil: passphrase.validUntil });
      return passphrase;
    },

    async revokePassphrase(id: string): Promise<Passphrase> {
      const passphrase = await platform.registry.revokePassphrase(id);
      const ledger = platform.ledger(passphrase.ledgerId);
      await ledger.api.record(actor, { type: 'passphrase.revoke', code: passphrase.code });
      await ledger.disconnect(`p:${passphrase.code.toLowerCase()}`);
      return passphrase;
    },
  };
}
