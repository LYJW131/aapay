import { messages } from './locale.ts';

export const join = messages({
  'zh-CN': {
    tagline: '一起花钱，轻松算账',
    label: '输入分享口令加入账本',
    placeholder: '口令',
    tooShort: (min: number) => `口令至少 ${min} 位`,
    invalidChars: '口令只能包含字母和数字',
    submit: '进入账本',
    admin: '管理员入口',
  },
  en: {
    tagline: 'Spend together, settle up easily',
    label: 'Enter a share passcode to join a ledger',
    placeholder: 'Passcode',
    tooShort: (min) => `Passcode must be at least ${min} characters`,
    invalidChars: 'Passcode can only contain letters and digits',
    submit: 'Open ledger',
    admin: 'Admin sign-in',
  },
});
