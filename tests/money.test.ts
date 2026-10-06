import { describe, expect, it } from 'vitest';
import { centsToInput, formatMoney, parseAmount, splitByWeights, splitEvenly } from '../src/shared/money.ts';

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

  it('splits by weights with the largest remainder, ties going to earlier members', () => {
    const amounts = (total: number, weights: number[]) =>
      splitByWeights(total, weights.map((weight, i) => ({ memberId: String(i), weight }))).map((s) => s.amount);
    expect(amounts(10000, [2, 1])).toEqual([6667, 3333]);
    expect(amounts(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(amounts(100, [1, 2, 1])).toEqual([25, 50, 25]);
    expect(amounts(7, [3, 3, 1])).toEqual([3, 3, 1]);
    expect(amounts(5, [1, 1, 1, 1, 1, 1])).toEqual([1, 1, 1, 1, 1, 0]);
    for (const [total, weights] of [[99_999_999, [7, 13, 1000]], [1, [1, 1]], [12345, [3, 5, 7, 11]]] as const) {
      expect(amounts(total, [...weights]).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});
