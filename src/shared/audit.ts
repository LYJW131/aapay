import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Cents } from './money.ts';
import type { IsoDate, Timestamp } from './types.ts';

export type AuditActor =
  | { kind: 'member'; passphrase: string | null }
  | { kind: 'admin'; name: string }
  | { kind: 'shared' }
  | { kind: 'ai'; client: string | null; host: string | null; verified: boolean };

export interface AuditExpense {
  id: string;
  title: string;
  amount: Cents;
  payer: string;
  participants: string[];
  date: IsoDate;
}

export interface AuditSettlement {
  id: string;
  from: string;
  to: string;
  amount: Cents;
  date: IsoDate;
  note: string | null;
}

export type AuditAction =
  | { type: 'ledger.create'; name: string; emoji?: string }
  | { type: 'ledger.rename'; from: string; to: string }
  | { type: 'ledger.update'; before: { name: string; emoji: string }; after: { name: string; emoji: string } }
  | { type: 'member.create'; name: string; avatar: string }
  | { type: 'member.update'; before: { name: string; avatar: string }; after: { name: string; avatar: string } }
  | { type: 'member.delete'; name: string }
  | { type: 'expense.create'; expense: AuditExpense }
  | { type: 'expense.update'; before: AuditExpense; after: AuditExpense }
  | { type: 'expense.delete'; expense: AuditExpense }
  | { type: 'settlement.create'; settlement: AuditSettlement }
  | { type: 'settlement.delete'; settlement: AuditSettlement }
  | { type: 'passphrase.create'; code: string; validUntil: Timestamp | null }
  | { type: 'passphrase.revoke'; code: string }
  | { type: 'connection.create'; client: string | null; host: string | null; scopes: string[] }
  | { type: 'connection.revoke'; client: string | null; host: string | null };

export interface AuditPayload {
  seq: number;
  at: Timestamp;
  actor: AuditActor;
  action: AuditAction;
}

export interface AuditRecord {
  seq: number;
  payload: string;
  prev: string;
  hash: string;
  sig: string | null;
}

export interface AuditPage {
  records: AuditRecord[];
  publicKey: string | null;
  head: { seq: number; hash: string } | null;
}

export const AUDIT_GENESIS = '0'.repeat(64);

export function auditHash(prev: string, payload: string) {
  return bytesToHex(sha256(utf8ToBytes(`${prev}\n${payload}`)));
}

export const parseAudit = (record: AuditRecord) => JSON.parse(record.payload) as AuditPayload;

export interface AuditCheckpoint {
  seq: number;
  hash: string;
  publicKey: string | null;
}

export type AuditVerdict =
  | { ok: true; checkpoint: AuditCheckpoint | null; signed: boolean }
  | { ok: false; seq: number; reason: AuditFailure };

export type AuditFailure = 'key-changed' | 'seq-gap' | 'prev-mismatch' | 'hash-mismatch' | 'seq-mismatch' | 'bad-signature';

export function keyFingerprint(publicKey: string) {
  return bytesToHex(sha256(hexToBytes(publicKey)).slice(0, 8)).match(/.{4}/g)!.join(' ');
}

export function verifyAudit(records: readonly AuditRecord[], publicKey: string | null, from: AuditCheckpoint | null): AuditVerdict {
  if (from && from.publicKey && from.publicKey !== publicKey) {
    return { ok: false, seq: from.seq, reason: 'key-changed' };
  }
  let seq = from?.seq ?? 0;
  let hash = from?.hash ?? AUDIT_GENESIS;
  const key = publicKey ? hexToBytes(publicKey) : null;
  for (const r of records) {
    if (r.seq !== seq + 1) return { ok: false, seq: r.seq, reason: 'seq-gap' };
    if (r.prev !== hash) return { ok: false, seq: r.seq, reason: 'prev-mismatch' };
    if (auditHash(r.prev, r.payload) !== r.hash) return { ok: false, seq: r.seq, reason: 'hash-mismatch' };
    if (parseAudit(r).seq !== r.seq) return { ok: false, seq: r.seq, reason: 'seq-mismatch' };
    if (key && (!r.sig || !safeVerify(r.sig, r.hash, key))) return { ok: false, seq: r.seq, reason: 'bad-signature' };
    seq = r.seq;
    hash = r.hash;
  }
  const signed = !!key;
  return { ok: true, signed, checkpoint: seq === 0 ? null : { seq, hash, publicKey } };
}

function safeVerify(sig: string, hash: string, key: Uint8Array) {
  try {
    return ed25519.verify(hexToBytes(sig), hexToBytes(hash), key);
  } catch {
    return false;
  }
}
