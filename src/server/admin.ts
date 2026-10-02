import type { AuditActor } from '../shared/audit.ts';
import type { LedgerInput, PassphraseInput } from '../shared/schema.ts';
import type { LedgerInfo, LedgerOverview, LedgerRecord, Passphrase } from '../shared/types.ts';
import type { Platform } from './platform.ts';

export function adminActions(platform: Platform, actor: AuditActor) {
  return {
    async listLedgers(): Promise<LedgerOverview[]> {
      const ledgers = await platform.registry.listLedgers();
      const stats = await Promise.all(ledgers.map((l) => platform.ledger(l.id).api.stats().catch(() => null)));
      return ledgers.map((l, i) => ({ ...l, stats: stats[i] ?? null }));
    },

    async createLedger(input: LedgerInput): Promise<LedgerRecord> {
      const ledger = await platform.registry.createLedger(input);
      await platform.ledger(ledger.id).api.record(actor, { type: 'ledger.create', name: ledger.name, emoji: ledger.emoji });
      return ledger;
    },

    async updateLedger(id: string, input: LedgerInput): Promise<LedgerInfo> {
      const before = await platform.registry.getLedger(id);
      const ledger = await platform.registry.updateLedger(id, input);
      const api = platform.ledger(ledger.id).api;
      await api.record(actor, {
        type: 'ledger.update',
        before: { name: before.name, emoji: before.emoji },
        after: { name: ledger.name, emoji: ledger.emoji },
      });
      await api.notify({ type: 'ledger.updated', ledger });
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
