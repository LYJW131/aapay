/** 金额统一以「分」为单位的整数存储与计算，避免浮点误差。 */
export type Cents = number;

export const MAX_AMOUNT: Cents = 99_999_999; // ¥999,999.99

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

/** 把用户输入的金额字符串（如 "12.3"）转成分；非法输入返回 null。 */
export function parseAmount(input: string): Cents | null {
  const text = input.trim().replace(/[,，\s¥￥]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return null;
  const [yuan = '0', fen = ''] = text.split('.');
  const cents = Number(yuan) * 100 + Number(fen.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_AMOUNT ? cents : null;
}

/** 把分转回可编辑的字符串（1230 → "12.3"）。 */
export function centsToInput(cents: Cents): string {
  return (cents / 100).toFixed(2).replace(/\.?0+$/, '');
}

/**
 * 平均分摊：每人得到 floor(total / n)，余下的几分钱依次分给排在前面的人，
 * 保证分摊之和恰好等于总额。
 */
export function splitEvenly(total: Cents, memberIds: readonly string[]): { memberId: string; amount: Cents }[] {
  const n = memberIds.length;
  if (n === 0) return [];
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return memberIds.map((memberId, i) => ({ memberId, amount: base + (i < remainder ? 1 : 0) }));
}
