import { useSyncExternalStore } from 'react';

const DURATION = 2400;
const listeners = new Set<() => void>();
let lit = new Set<string>();

function emit() {
  for (const l of listeners) l();
}

export function highlight(ids: readonly string[]) {
  if (ids.length === 0) return;
  lit = new Set([...lit, ...ids]);
  emit();
  setTimeout(() => {
    lit = new Set([...lit].filter((id) => !ids.includes(id)));
    emit();
  }, DURATION);
}

export function useHighlighted(id: string) {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    () => lit.has(id),
  );
}
