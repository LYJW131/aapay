import { Plus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { ledger } from '../../i18n/ledger.ts';
import { useMediaQuery } from '../../lib/hooks.ts';
import { useLedger } from '../ledger/context.tsx';
import { AssistantContext, type AssistantApi } from './context.ts';

const UNAVAILABLE: AssistantApi = { available: false, open: () => undefined };

export function AssistantDock({ onCompose, children }: { enabled: boolean; onCompose: () => void; children: ReactNode }) {
  const { snapshot } = useLedger();
  const desktop = useMediaQuery('(min-width: 1024px)');
  return (
    <AssistantContext value={UNAVAILABLE}>
      {children}
      <AnimatePresence>
        {!desktop && snapshot.members.length > 0 && (
          <motion.button
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            whileTap={{ scale: 0.92 }}
            onClick={onCompose}
            className="fixed right-5 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-20 flex h-14 items-center gap-2 rounded-full bg-gradient-to-br from-brand-500 to-accent-500 pr-6 pl-5 font-semibold text-white shadow-[0_12px_32px_-8px] shadow-brand-500/70"
          >
            <Plus className="size-5" strokeWidth={2.5} />
            {ledger.page.addExpense}
          </motion.button>
        )}
      </AnimatePresence>
    </AssistantContext>
  );
}
