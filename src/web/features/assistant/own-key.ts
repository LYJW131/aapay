import { useSyncExternalStore } from 'react';
import { AI_BASE_URL_HEADER, AI_KEY_HEADER, AI_MODEL_HEADER, AI_PROVIDER_HEADER, isAiProvider, type AiProvider } from '../../../shared/assistant.ts';
import { assistant } from '../../i18n/assistant.ts';
import { api, call } from '../../lib/api.ts';
import { load, save } from '../../lib/storage.ts';

export interface OwnKey {
  provider: AiProvider;
  key: string;
  model: string | null;
  baseUrl: string | null;
}

export const PROVIDER_NAMES: Record<AiProvider, string> = { gemini: 'Gemini', deepseek: 'DeepSeek', claude: 'Claude', openai: assistant.key.openai };

export const KEY_PAGES: Record<AiProvider, string | null> = {
  gemini: 'https://aistudio.google.com/apikey',
  deepseek: 'https://platform.deepseek.com/api_keys',
  claude: 'https://platform.claude.com/settings/keys',
  openai: null,
};

const STORAGE = 'aapay:ai-key';
const listeners = new Set<() => void>();

function read(): OwnKey | null {
  const value = load<Partial<OwnKey> | null>(STORAGE, null);
  if (!isAiProvider(value?.provider) || typeof value.key !== 'string') return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  return { provider: value.provider, key: value.key, model: text(value.model), baseUrl: text(value.baseUrl) };
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
  own
    ? {
        [AI_PROVIDER_HEADER]: own.provider,
        [AI_KEY_HEADER]: own.key,
        ...(own.model && { [AI_MODEL_HEADER]: own.model }),
        ...(own.baseUrl && { [AI_BASE_URL_HEADER]: own.baseUrl }),
      }
    : {};

export const verifyOwnKey = (own: OwnKey) => call(api.ledger.assistant.key.$post({}, { headers: ownKeyHeaders(own) }));
