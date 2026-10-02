import { describe, expect, it } from 'vitest';
import { centsToInput, formatMoney, parseAmount, splitEvenly } from '../src/shared/money.ts';

describe('money', () => {
  it('parses user input into cents', () => {
    expect(parseAmount('12.3')).toBe(1230);
    expect(parseAmount('¥1,234.56')).toBe(123456);
    expect(parseAmount('0.01')).toBe(1);
    expect(parseAmount('8')).toBe(800);
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('1.234')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('1000000')).toBeNull();
  });

  it('formats cents', () => {
    expect(formatMoney(123456)).toBe('¥1,234.56');
    expect(formatMoney(-500)).toBe('-¥5.00');
    expect(formatMoney(500, { sign: true })).toBe('+¥5.00');
    expect(centsToInput(1230)).toBe('12.3');
    expect(centsToInput(1200)).toBe('12');
  });

  it('splits evenly and distributes the remainder', () => {
    const shares = splitEvenly(1000, ['a', 'b', 'c']);
    expect(shares.map((s) => s.amount)).toEqual([334, 333, 333]);
    expect(shares.reduce((t, s) => t + s.amount, 0)).toBe(1000);
  });
});
