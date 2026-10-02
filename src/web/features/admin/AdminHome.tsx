import { useEffect } from 'react';
import { toast } from 'sonner';
import type { AdminIdentity, SessionInfo } from '../../../shared/types.ts';
import { Wordmark } from '../../components/Logo.tsx';
import { AdminCard } from './AdminCard.tsx';

/** 管理员尚未进入任何账本时的首页：只有一张管理卡片 */
export function AdminHome({ admin, notice, onEnter }: { admin: AdminIdentity; notice?: string; onEnter: (session: SessionInfo) => void }) {
  useEffect(() => {
    document.title = 'AAPay';
    if (notice) toast(notice);
  }, [notice]);

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex h-14 max-w-3xl items-center px-4">
        <Wordmark className="text-lg" />
      </header>
      <main className="mx-auto max-w-3xl px-4 pt-2 pb-12">
        <AdminCard admin={admin} current={null} onEnter={onEnter} standalone />
      </main>
    </div>
  );
}
