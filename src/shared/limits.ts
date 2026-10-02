/** 各字段长度与数量限制（前后端共用；不依赖 zod，避免把校验库打进前端包） */
export const LIMITS = {
  members: 30,
  memberName: 12,
  avatar: 16,
  title: 24,
  note: 40,
  ledgerName: 16,
  codeMin: 3,
  codeMax: 24,
} as const;
