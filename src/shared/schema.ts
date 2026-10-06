import { z } from 'zod';
import { CATEGORIES } from './categories.ts';
import type { PlainErrorKey } from './errors.ts';
import { ID_PATTERN } from './ids.ts';
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

export const category = z.enum(CATEGORIES, msg('categoryInvalid'));

const shareAmount = z
  .number()
  .int(msg('amountNotCents'))
  .min(1, msg('shareNotPositive'))
  .max(MAX_AMOUNT, msg('amountTooLarge'));

export const expenseSplit = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('even'),
    memberIds: z
      .array(id)
      .min(1, msg('participantsRequired'))
      .max(LIMITS.members, msg('participantsTooMany'))
      .refine((ids) => new Set(ids).size === ids.length, msg('participantsDuplicate')),
  }),
  z.object({
    mode: z.literal('exact'),
    shares: z
      .array(z.object({ memberId: id, amount: shareAmount }))
      .min(1, msg('participantsRequired'))
      .max(LIMITS.members, msg('participantsTooMany'))
      .refine((shares) => new Set(shares.map((s) => s.memberId)).size === shares.length, msg('sharesDuplicate')),
  }),
]);

export const expenseInput = z
  .object({
    title: text(LIMITS.title, 'titleRequired', 'titleTooLong'),
    amount,
    payerId: id,
    date: isoDate,
    category: category.nullable(),
    split: expenseSplit,
  })
  .superRefine((e, ctx) => {
    if (e.split.mode === 'exact' && e.split.shares.reduce((sum, s) => sum + s.amount, 0) !== e.amount) {
      ctx.addIssue({ code: 'custom', message: msg('sharesSumMismatch'), path: ['split', 'shares'] });
    }
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

const recordId = z.string().regex(ID_PATTERN, msg('idInvalid'));
const ifUpdatedAt = z.number().int().nonnegative().optional();

export const changeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('member.create'), id: recordId, member: memberInput }),
  z.object({ op: z.literal('member.update'), id: recordId, member: memberInput }),
  z.object({ op: z.literal('member.delete'), id: recordId }),
  z.object({ op: z.literal('expense.create'), id: recordId, expense: expenseInput }),
  z.object({ op: z.literal('expense.update'), id: recordId, expense: expenseInput, ifUpdatedAt }),
  z.object({ op: z.literal('expense.delete'), id: recordId, ifUpdatedAt }),
  z.object({ op: z.literal('settlement.create'), id: recordId, settlement: settlementInput }),
  z.object({ op: z.literal('settlement.delete'), id: recordId }),
]);

export const changeList = z.array(changeSchema).min(1, msg('changesRequired')).max(LIMITS.changes, msg('changesTooMany'));

export const changesInput = z.object({
  changes: changeList,
  via: z.literal('assistant').optional(),
});

const imageDataUrl = z
  .string()
  .max(4_000_000, msg('imageTooLarge'))
  .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/, msg('imageFormat'));

export const recognizeInput = z.object({ image: imageDataUrl });

export const assistantInput = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(LIMITS.assistantText) }))
    .min(1)
    .max(LIMITS.assistantHistory)
    .refine((turns) => turns.at(-1)!.role === 'user', msg('invalidParams')),
  images: z.array(imageDataUrl).max(LIMITS.assistantImages).default([]),
  pending: z.array(changeSchema).max(LIMITS.changes).default([]),
  me: z.string().min(1).max(64).nullable(),
  participants: z.array(z.string().min(1).max(64)).max(LIMITS.members).nullable(),
  today: isoDate,
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
export type ExpenseSplit = z.infer<typeof expenseSplit>;
export type ChangesInput = z.infer<typeof changesInput>;
export type SettlementInput = z.infer<typeof settlementInput>;
export type PassphraseInput = z.infer<typeof passphraseInput>;
