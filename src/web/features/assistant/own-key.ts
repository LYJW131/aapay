import { useSyncExternalStore } from 'react';
import { GEMINI_KEY_HEADER, GEMINI_MODEL_HEADER } from '../../../shared/assistant.ts';
import { api, call } from '../../lib/api.ts';
import { load, save } from '../../lib/storage.ts';

export interface OwnKey {
  key: string;
  model: string | null;
}

const STORAGE = 'aapay:gemini';
const listeners = new Set<() => void>();

function read(): OwnKey | null {
  const value = load<Partial<OwnKey> | null>(STORAGE, null);
  return typeof value?.key === 'string' ? { key: value.key, model: typeof value.model === 'string' ? value.model : null } : null;
}

let current = read();

window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE) return;
  current = read();
  listeners.forEach((l) => l());
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function setOwnKey(next: OwnKey | null) {
  current = next;
  save(STORAGE, next);
  listeners.forEach((l) => l());
}

export const useOwnKey = () => useSyncExternalStore(subscribe, () => current);

export const ownKeyHeaders = (own = current): Record<string, string> =>
  own ? { [GEMINI_KEY_HEADER]: own.key, ...(own.model && { [GEMINI_MODEL_HEADER]: own.model }) } : {};

export const verifyOwnKey = (own: OwnKey) => call(api.ledger.assistant.key.$post({}, { headers: ownKeyHeaders(own) }));
