import { useEffect } from 'react';
import { toast } from 'sonner';
import type { AdminIdentity, SessionInfo } from '../../../shared/types.ts';
import { LanguageSwitch } from '../../components/LanguageSwitch.tsx';
import { Wordmark } from '../../components/Logo.tsx';
import { AdminCard } from './AdminCard.tsx';

export function AdminHome({ admin, notice, onEnter }: { admin: AdminIdentity; notice?: string; onEnter: (session: SessionInfo) => Promise<void> }) {
  useEffect(() => {
    document.title = 'AAPay';
    if (notice) toast(notice);
  }, [notice]);

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
        <Wordmark className="text-lg" />
        <LanguageSwitch />
      </header>
      <main className="mx-auto max-w-3xl px-4 pt-2 pb-12">
        <AdminCard admin={admin} current={null} onEnter={onEnter} standalone />
      </main>
    </div>
  );
}
