import type { Category } from '../../../shared/categories.ts';
import type { Expense, Settlement } from '../../../shared/types.ts';
import type { RangeFilter } from './range.ts';

export type CategoryFilter = Category | 'none' | null;

export interface LedgerFilters {
  range: RangeFilter;
  memberId: string | null;
  category: CategoryFilter;
  query: string;
}

export function inCategory(record: Expense | Settlement, category: CategoryFilter) {
  if (category === null) return true;
  if (!('payerId' in record)) return false;
  return category === 'none' ? record.category === null : record.category === category;
}
