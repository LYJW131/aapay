import { z } from 'zod';
import type { PlainErrorKey } from './errors.ts';
import { LIMITS } from './limits.ts';
import { MAX_AMOUNT } from './money.ts';

export { LIMITS };

const msg = (key: PlainErrorKey) => key;
const id = z.string().min(1).max(64);
const text = (max: number, required: PlainErrorKey, tooLong: PlainErrorKey) => z.string().trim().min(1, required).max(max, tooLong);

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, msg('dateFormat'))
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), msg('dateInvalid'));

export const amount = z
  .number()
  .int(msg('amountNotCents'))
  .min(1, msg('amountNotPositive'))
  .max(MAX_AMOUNT, msg('amountTooLarge'));

export const passphraseCode = z
  .string()
  .trim()
  .min(LIMITS.codeMin, msg('codeTooShort'))
  .max(LIMITS.codeMax, msg('codeTooLong'))
  .regex(/^[a-zA-Z0-9]+$/, msg('codeCharset'));

export const memberInput = z.object({
  name: text(LIMITS.memberName, 'memberNameRequired', 'memberNameTooLong'),
  avatar: z.string().trim().max(LIMITS.avatar).optional(),
});

export const expenseInput = z.object({
  title: text(LIMITS.title, 'titleRequired', 'titleTooLong'),
  amount,
  payerId: id,
  date: isoDate,
  participantIds: z
    .array(id)
    .min(1, msg('participantsRequired'))
    .max(LIMITS.members)
    .refine((ids) => new Set(ids).size === ids.length, msg('participantsDuplicate')),
});

export const settlementInput = z
  .object({
    fromId: id,
    toId: id,
    amount,
    date: isoDate,
    note: z.string().trim().max(LIMITS.note).nullish(),
  })
  .refine((s) => s.fromId !== s.toId, { message: msg('settlementSamePerson'), path: ['toId'] });

export const recognizeInput = z.object({
  image: z
    .string()
    .max(4_000_000, msg('imageTooLarge'))
    .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/, msg('imageFormat')),
});

export const joinInput = z.object({ code: passphraseCode });
export const loginInput = z.object({ password: z.string().min(1).max(256) });
export const ledgerInput = z.object({ name: text(LIMITS.ledgerName, 'ledgerNameRequired', 'ledgerNameTooLong'), emoji: z.string().trim().max(LIMITS.avatar).optional() });

export const passphraseInput = z
  .object({
    code: passphraseCode,
    validFrom: z.number().int().nonnegative().optional(),
    validUntil: z.number().int().positive().nullable(),
  })
  .refine((p) => p.validUntil === null || p.validUntil > (p.validFrom ?? 0), {
    message: msg('validUntilBeforeFrom'),
    path: ['validUntil'],
  });

export type MemberInput = z.infer<typeof memberInput>;
export type LedgerInput = z.infer<typeof ledgerInput>;
export type ExpenseInput = z.infer<typeof expenseInput>;
export type SettlementInput = z.infer<typeof settlementInput>;
export type PassphraseInput = z.infer<typeof passphraseInput>;
