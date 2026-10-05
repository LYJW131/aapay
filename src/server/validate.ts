import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import type { z } from 'zod';
import { isPlainErrorKey, translateError } from '../shared/errors.ts';
import { negotiateLocale, type Locale } from '../shared/i18n.ts';

export const localeOf = (c: Context): Locale => negotiateLocale(c.req.header('accept-language'));

export function issueMessage(locale: Locale, error: { issues: readonly { message: string }[] }) {
  const message = error.issues[0]?.message;
  return translateError(locale, message && isPlainErrorKey(message) ? message : 'invalidParams');
}

const validator = <Target extends 'json' | 'query', T extends z.ZodType>(target: Target, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) return c.json({ error: issueMessage(localeOf(c), result.error) }, 400);
  });

export const body = <T extends z.ZodType>(schema: T) => validator('json', schema);
export const query = <T extends z.ZodType>(schema: T) => validator('query', schema);
