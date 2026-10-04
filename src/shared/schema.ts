import { z } from 'zod';
import { LIMITS } from './limits.ts';
import { MAX_AMOUNT } from './money.ts';

export { LIMITS };

const id = z.string().min(1).max(64);
const text = (max: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label}不能为空`)
    .max(max, `${label}最多 ${max} 个字`);

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), '日期无效');

export const amount = z
  .number()
  .int('金额需以分为单位')
  .min(1, '金额必须大于 0')
  .max(MAX_AMOUNT, '金额过大');

export const passphraseCode = z
  .string()
  .trim()
  .min(LIMITS.codeMin, `口令至少 ${LIMITS.codeMin} 位`)
  .max(LIMITS.codeMax, `口令最多 ${LIMITS.codeMax} 位`)
  .regex(/^[a-zA-Z0-9]+$/, '口令只能包含字母和数字');

export const memberInput = z.object({
  name: text(LIMITS.memberName, '名字'),
  avatar: z.string().trim().max(LIMITS.avatar).optional(),
});

export const expenseInput = z.object({
  title: text(LIMITS.title, '用途'),
  amount,
  payerId: id,
  date: isoDate,
  participantIds: z
    .array(id)
    .min(1, '至少选择一位参与者')
    .max(LIMITS.members)
    .refine((ids) => new Set(ids).size === ids.length, '参与者重复'),
});

export const settlementInput = z
  .object({
    fromId: id,
    toId: id,
    amount,
    date: isoDate,
    note: z.string().trim().max(LIMITS.note).nullish(),
  })
  .refine((s) => s.fromId !== s.toId, { message: '付款人和收款人不能相同', path: ['toId'] });

export const recognizeInput = z.object({
  image: z
    .string()
    .max(4_000_000, '图片过大')
    .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/, '图片格式不支持'),
});

export const joinInput = z.object({ code: passphraseCode });
export const loginInput = z.object({ password: z.string().min(1).max(256) });
export const ledgerInput = z.object({ name: text(LIMITS.ledgerName, '账本名称'), emoji: z.string().trim().max(LIMITS.avatar).optional() });

export const passphraseInput = z
  .object({
    code: passphraseCode,
    validFrom: z.number().int().nonnegative().optional(),
    validUntil: z.number().int().positive().nullable(),
  })
  .refine((p) => p.validUntil === null || p.validUntil > (p.validFrom ?? 0), {
    message: '结束时间必须晚于开始时间',
    path: ['validUntil'],
  });

export type MemberInput = z.infer<typeof memberInput>;
export type LedgerInput = z.infer<typeof ledgerInput>;
export type ExpenseInput = z.infer<typeof expenseInput>;
export type SettlementInput = z.infer<typeof settlementInput>;
export type PassphraseInput = z.infer<typeof passphraseInput>;
