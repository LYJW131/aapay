import { describe, expect, it } from 'vitest';
import { describeAudit } from '../src/shared/audit-text.ts';
import { ERRORS, translateError } from '../src/shared/errors.ts';
import { negotiateLocale } from '../src/shared/i18n.ts';

describe('i18n', () => {
  it('negotiates the locale from Accept-Language', () => {
    expect(negotiateLocale(undefined)).toBe('zh-CN');
    expect(negotiateLocale('en-GB,en;q=0.9')).toBe('en');
    expect(negotiateLocale('zh-TW,zh;q=0.9,en;q=0.8')).toBe('zh-CN');
    expect(negotiateLocale('fr-FR,en;q=0.5,zh;q=0.8')).toBe('zh-CN');
    expect(negotiateLocale('ja,en;q=0.1')).toBe('en');
    expect(negotiateLocale('de')).toBe('zh-CN');
  });

  it('translates every error in both locales', () => {
    expect(Object.keys(ERRORS.en)).toEqual(Object.keys(ERRORS['zh-CN']));
    expect(translateError('en', 'ledgerExists', { name: 'Trip' })).toBe('A ledger named “Trip” already exists');
    expect(translateError('zh-CN', 'ledgerExists', { name: 'Trip' })).toBe('账本「Trip」已存在');
  });

  it('describes audit actions in English', () => {
    const settlement = { id: 's1', from: 'Amy', to: 'Bob', amount: 1050, date: '2026-10-01', note: 'cash' };
    expect(describeAudit({ type: 'settlement.create', settlement }, 'en')).toEqual({
      summary: 'Recorded a payment: Amy → Bob ¥10.50',
      details: ['Note: cash'],
    });
  });
});
