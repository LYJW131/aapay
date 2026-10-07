export type Cents = number;

export const MAX_AMOUNT: Cents = 99_999_999;

const formatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(cents: Cents, { sign = false }: { sign?: boolean } = {}): string {
  const text = formatter.format(Math.abs(cents) / 100);
  if (cents < 0) return `-${text}`;
  return sign && cents > 0 ? `+${text}` : text;
}

export function parseAmount(input: string): Cents | null {
  const text = input.trim().replace(/[,，\s¥￥]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return null;
  const [yuan = '0', fen = ''] = text.split('.');
  const cents = Number(yuan) * 100 + Number(fen.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_AMOUNT ? cents : null;
}

export function centsToInput(cents: Cents): string {
  return (cents / 100).toFixed(2).replace(/\.?0+$/, '');
}

// 余下的几分钱依次分给排在前面的人，保证分摊之和恰好等于总额
export function splitEvenly(total: Cents, memberIds: readonly string[]): { memberId: string; amount: Cents }[] {
  const n = memberIds.length;
  if (n === 0) return [];
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return memberIds.map((memberId, i) => ({ memberId, amount: base + (i < remainder ? 1 : 0) }));
}

export function splitByWeights(total: Cents, weights: readonly { memberId: string; weight: number }[]): { memberId: string; amount: Cents }[] {
  const sum = weights.reduce((acc, w) => acc + w.weight, 0);
  if (sum <= 0) return weights.map(({ memberId }) => ({ memberId, amount: 0 }));
  const parts = weights.map(({ memberId, weight }, index) => {
    const base = Math.floor((total * weight) / sum);
    return { memberId, amount: base, remainder: total * weight - base * sum, index };
  });
  let left = total - parts.reduce((acc, p) => acc + p.amount, 0);
  for (const p of [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (left <= 0) break;
    p.amount += 1;
    left -= 1;
  }
  return parts.map(({ memberId, amount }) => ({ memberId, amount }));
}
