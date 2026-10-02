import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export interface AuditSigner {
  publicKey: string;
  sign(hash: string): string;
}

export function createSigner(seed: Uint8Array): AuditSigner {
  return {
    publicKey: bytesToHex(ed25519.getPublicKey(seed)),
    sign: (hash) => bytesToHex(ed25519.sign(hexToBytes(hash), seed)),
  };
}
