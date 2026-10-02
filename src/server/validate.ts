import { zValidator } from '@hono/zod-validator';
import type { z } from 'zod';

/** 统一的参数校验：失败时返回第一条中文错误信息 */
export const body = <T extends z.ZodType>(schema: T) =>
  zValidator('json', schema, (result, c) => {
    if (!result.success) return c.json({ error: result.error.issues[0]?.message ?? '参数错误' }, 400);
  });
