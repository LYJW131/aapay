import { zValidator } from '@hono/zod-validator';
import type { z } from 'zod';

const validator = <Target extends 'json' | 'query', T extends z.ZodType>(target: Target, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) return c.json({ error: result.error.issues[0]?.message ?? '参数错误' }, 400);
  });

export const body = <T extends z.ZodType>(schema: T) => validator('json', schema);
export const query = <T extends z.ZodType>(schema: T) => validator('query', schema);
