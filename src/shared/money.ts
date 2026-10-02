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
