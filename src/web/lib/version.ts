import { useEffect, useState } from 'react';
import type { BuildInfo } from '../../shared/types.ts';

export const BUILD = __BUILD__;
export const REPO_URL = BUILD.repo;

const INTERVAL = 30 * 60_000;
const MIN_GAP = 60_000;

async function fetchDeployed(): Promise<BuildInfo | null> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const info = (await res.json()) as BuildInfo;
    return typeof info.commit === 'string' && info.commit ? info : null;
  } catch {
    return null;
  }
}

export function useDeployedUpdate() {
  const [update, setUpdate] = useState<BuildInfo | null>(null);
  useEffect(() => {
    if (import.meta.env.DEV || !BUILD.commit) return;
    let last = 0;
    const check = async () => {
      if (Date.now() - last < MIN_GAP) return;
      last = Date.now();
      const deployed = await fetchDeployed();
      setUpdate(deployed && deployed.commit !== BUILD.commit ? deployed : null);
    };
    const onVisible = () => document.visibilityState === 'visible' && void check();
    const first = setTimeout(check, 3000);
    const timer = setInterval(check, INTERVAL);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return update;
}
