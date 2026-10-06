import { describe, expect, it } from 'vitest';
import { CATEGORIES, CATEGORY_EMOJI, CATEGORY_LABELS, guessCategory } from '../src/shared/categories.ts';
import { computeShares, splitOf } from '../src/shared/ledger.ts';
import type { Member } from '../src/shared/types.ts';

describe('categories', () => {
  it('has an emoji and a label in both languages for every category', () => {
    for (const c of CATEGORIES) {
      expect(CATEGORY_EMOJI[c]).toBeTruthy();
      expect(CATEGORY_LABELS['zh-CN'][c]).toBeTruthy();
      expect(CATEGORY_LABELS.en[c]).toBeTruthy();
    }
  });

  it('guesses from Chinese and English keywords', () => {
    expect(guessCategory('火锅')).toBe('food');
    expect(guessCategory('Morning Coffee')).toBe('food');
    expect(guessCategory('超市买菜')).toBe('groceries');
    expect(guessCategory('滴滴打车')).toBe('transport');
    expect(guessCategory('Uber home')).toBe('transport');
    expect(guessCategory('民宿两晚')).toBe('lodging');
    expect(guessCategory('KTV')).toBe('fun');
    expect(guessCategory('淘宝')).toBe('shopping');
    expect(guessCategory('十月房租')).toBe('housing');
    expect(guessCategory('电费')).toBe('housing');
    expect(guessCategory('挂号')).toBe('health');
    expect(guessCategory('份子钱')).toBe('gifts');
    expect(guessCategory('杂项')).toBeNull();
    expect(guessCategory('  ')).toBeNull();
  });
});

describe('splits', () => {
  const members: Member[] = ['a', 'b', 'c'].map((id, i) => ({ id, name: id, avatar: '', createdAt: i }));

  it('writes shares in join order and recognises even splits', () => {
    expect(computeShares(1000, { mode: 'even', memberIds: ['c', 'a', 'b'] }, members)).toEqual([
      { memberId: 'a', amount: 334 },
      { memberId: 'b', amount: 333 },
      { memberId: 'c', amount: 333 },
    ]);
    expect(splitOf({ amount: 1000, shares: [{ memberId: 'c', amount: 500 }, { memberId: 'a', amount: 500 }] }, members)).toEqual({
      mode: 'even',
      memberIds: ['a', 'c'],
    });
    expect(splitOf({ amount: 1000, shares: [{ memberId: 'a', amount: 333 }, { memberId: 'c', amount: 667 }] }, members)).toEqual({
      mode: 'exact',
      shares: [
        { memberId: 'a', amount: 333 },
        { memberId: 'c', amount: 667 },
      ],
    });
    expect(splitOf({ amount: 1000, shares: [{ memberId: 'a', amount: 333 }, { memberId: 'b', amount: 334 }, { memberId: 'c', amount: 333 }] }, members).mode).toBe('exact');
  });
});
