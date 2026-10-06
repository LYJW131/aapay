// 不依赖 zod，避免把校验库打进前端包
export const LIMITS = {
  members: 30,
  memberName: 12,
  avatar: 16,
  title: 24,
  note: 40,
  ledgerName: 16,
  codeMin: 3,
  codeMax: 24,
  changes: 100,
  assistantText: 4000,
  assistantHistory: 40,
  assistantImages: 6,
} as const;
