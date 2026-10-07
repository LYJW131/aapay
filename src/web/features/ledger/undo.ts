import { toast } from 'sonner';
import type { Change } from '../../../shared/changes.ts';
import { common } from '../../i18n/common.ts';
import { errorMessage } from '../../lib/api.ts';
import type { LedgerStore } from './store.ts';

export function undoAction(store: LedgerStore, undo: Change[]) {
  if (undo.length === 0) return undefined;
  return {
    label: common.undo,
    onClick: () =>
      void store.apply(undo).then(
        () => toast.success(common.undone),
        (err: unknown) => toast.error(errorMessage(err)),
      ),
  };
}
