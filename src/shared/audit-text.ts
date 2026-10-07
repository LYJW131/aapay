import type { AuditAction, AuditActor, AuditExpense } from './audit.ts';
import { CATEGORY_EMOJI, CATEGORY_LABELS, isCategory } from './categories.ts';
import type { Via } from './changes.ts';
import { defineMessages, type Locale } from './i18n.ts';
import { formatMoney } from './money.ts';

const TEXT = defineMessages({
  'zh-CN': {
    member: (passphrase: string | null) => (passphrase ? `成员（口令 ${passphrase}）` : '成员'),
    admin: (name: string) => `管理员 ${name}`,
    shared: '访客',
    aiApp: 'AI 应用',
    host: (host: string) => `（${host}）`,
    unverified: ' · 名称未验证',
    separator: '、',
    expenseLine: (e: AuditExpense) =>
      `「${e.title}」${formatMoney(e.amount)}，${e.payer} 付，${e.participants.length} 人${e.split ? '按金额' : ''}分摊（${e.date}）`,
    via: { assistant: '经 AI 助手' },
    title: '用途',
    category: '分类',
    uncategorized: '未分类',
    amount: '金额',
    payer: '付款人',
    date: '日期',
    split: '分摊',
    name: '名称',
    memberName: '名字',
    emoji: '图标',
    avatar: '头像',
    note: (note: string) => `备注：${note}`,
    field: (label: string, before: string, after: string) => `${label}：${before} → ${after}`,
    labelled: (label: string, value: string) => `${label}：${value}`,
    ledgerCreate: (emoji: string, name: string) => `创建了账本 ${emoji ? `${emoji} ` : ''}「${name}」`,
    ledgerRename: (from: string, to: string) => `把账本「${from}」改名为「${to}」`,
    ledgerUpdate: (name: string) => `修改了账本「${name}」`,
    memberCreate: (avatar: string, name: string) => `添加了成员 ${avatar} ${name}`,
    memberUpdate: (name: string) => `修改了成员 ${name}`,
    memberDelete: (name: string) => `移除了成员 ${name}`,
    expenseCreate: (line: string) => `记了一笔${line}`,
    expenseUpdate: (title: string) => `修改了「${title}」`,
    expenseDelete: (line: string) => `删除了${line}`,
    settlementCreate: (from: string, to: string, amount: string) => `记录还款：${from} → ${to} ${amount}`,
    settlementDelete: (from: string, to: string, amount: string) => `撤销了还款：${from} → ${to} ${amount}`,
    passphraseCreate: (code: string) => `生成了分享口令 ${code}`,
    validUntil: (ts: number) => `有效期至 ${new Date(ts).toLocaleString('zh-CN', { hour12: false })}`,
    forever: '永久有效',
    passphraseRevoke: (code: string) => `撤销了分享口令 ${code}`,
    connectionCreate: (client: string) => `授权 ${client} 连接本账本`,
    readWrite: '可以查看和记账',
    readOnly: '只读',
    connectionRevoke: (client: string) => `断开了 ${client} 的连接`,
  },
  en: {
    member: (passphrase) => (passphrase ? `Member (passcode ${passphrase})` : 'Member'),
    admin: (name) => `Admin ${name}`,
    shared: 'Guest',
    aiApp: 'AI app',
    host: (host) => ` (${host})`,
    unverified: ' · unverified name',
    separator: ', ',
    expenseLine: (e) =>
      `“${e.title}” ${formatMoney(e.amount)}, paid by ${e.payer}, ${e.split ? 'custom split' : 'split'} ${e.participants.length} ${e.participants.length === 1 ? 'way' : 'ways'} (${e.date})`,
    via: { assistant: 'via AI assistant' },
    title: 'Description',
    category: 'Category',
    uncategorized: 'Uncategorized',
    amount: 'Amount',
    payer: 'Paid by',
    date: 'Date',
    split: 'Split',
    name: 'Name',
    memberName: 'Name',
    emoji: 'Icon',
    avatar: 'Avatar',
    note: (note) => `Note: ${note}`,
    field: (label, before, after) => `${label}: ${before} → ${after}`,
    labelled: (label, value) => `${label}: ${value}`,
    ledgerCreate: (emoji, name) => `Created ledger ${emoji ? `${emoji} ` : ''}“${name}”`,
    ledgerRename: (from, to) => `Renamed ledger “${from}” to “${to}”`,
    ledgerUpdate: (name) => `Updated ledger “${name}”`,
    memberCreate: (avatar, name) => `Added member ${avatar} ${name}`,
    memberUpdate: (name) => `Updated member ${name}`,
    memberDelete: (name) => `Removed member ${name}`,
    expenseCreate: (line) => `Added ${line}`,
    expenseUpdate: (title) => `Edited “${title}”`,
    expenseDelete: (line) => `Deleted ${line}`,
    settlementCreate: (from, to, amount) => `Recorded a payment: ${from} → ${to} ${amount}`,
    settlementDelete: (from, to, amount) => `Undid a payment: ${from} → ${to} ${amount}`,
    passphraseCreate: (code) => `Created share passcode ${code}`,
    validUntil: (ts) => `Valid until ${new Date(ts).toLocaleString('en-US', { hour12: false })}`,
    forever: 'Never expires',
    passphraseRevoke: (code) => `Revoked share passcode ${code}`,
    connectionCreate: (client) => `Authorized ${client} to access this ledger`,
    readWrite: 'Can view and add records',
    readOnly: 'Read-only',
    connectionRevoke: (client) => `Disconnected ${client}`,
  },
});

export const viaLabel = (via: Via, locale: Locale) => TEXT[locale].via[via];

function baseActorLabel(actor: AuditActor, t: (typeof TEXT)[Locale]): string {
  switch (actor.kind) {
    case 'member':
      return t.member(actor.passphrase);
    case 'admin':
      return t.admin(actor.name);
    case 'shared':
      return t.shared;
    case 'ai':
      return `${actor.client ?? t.aiApp}${actor.host ? t.host(actor.host) : ''}${actor.verified ? '' : t.unverified}`;
  }
}

export function actorLabel(actor: AuditActor, locale: Locale, via?: Via): string {
  const label = baseActorLabel(actor, TEXT[locale]);
  return via ? `${label} · ${viaLabel(via, locale)}` : label;
}

export function categoryLabel(category: string | null | undefined, locale: Locale) {
  if (!category) return TEXT[locale].uncategorized;
  return isCategory(category) ? `${CATEGORY_EMOJI[category]} ${CATEGORY_LABELS[locale][category]}` : category;
}

const splitText = (t: (typeof TEXT)[Locale], e: AuditExpense) =>
  e.split ? e.split.map((s) => `${s.name} ${formatMoney(s.amount)}`).join(t.separator) : e.participants.join(t.separator);

function expenseDetails(t: (typeof TEXT)[Locale], e: AuditExpense, locale: Locale) {
  const details: string[] = [];
  if (e.category) details.push(t.labelled(t.category, categoryLabel(e.category, locale)));
  if (e.split) details.push(t.labelled(t.split, splitText(t, e)));
  return details;
}

function expenseChanges(t: (typeof TEXT)[Locale], before: AuditExpense, after: AuditExpense, locale: Locale) {
  const changes: string[] = [];
  if (before.title !== after.title) changes.push(t.field(t.title, before.title, after.title));
  if (before.amount !== after.amount) changes.push(t.field(t.amount, formatMoney(before.amount), formatMoney(after.amount)));
  if (before.payer !== after.payer) changes.push(t.field(t.payer, before.payer, after.payer));
  if (before.date !== after.date) changes.push(t.field(t.date, before.date, after.date));
  if ((before.category ?? null) !== (after.category ?? null)) {
    changes.push(t.field(t.category, categoryLabel(before.category, locale), categoryLabel(after.category, locale)));
  }
  const from = splitText(t, before);
  const to = splitText(t, after);
  if (from !== to) changes.push(t.field(t.split, from, to));
  return changes;
}

export function describeAudit(action: AuditAction, locale: Locale): { summary: string; details: string[] } {
  const t = TEXT[locale];
  const client = (name: string | null, host: string | null) => `${name ?? t.aiApp}${host ? t.host(host) : ''}`;
  switch (action.type) {
    case 'ledger.create':
      return { summary: t.ledgerCreate(action.emoji ?? '', action.name), details: [] };
    case 'ledger.rename':
      return { summary: t.ledgerRename(action.from, action.to), details: [] };
    case 'ledger.update': {
      const details: string[] = [];
      if (action.before.name !== action.after.name) details.push(t.field(t.name, action.before.name, action.after.name));
      if (action.before.emoji !== action.after.emoji) details.push(t.field(t.emoji, action.before.emoji, action.after.emoji));
      return { summary: t.ledgerUpdate(action.after.name), details };
    }
    case 'member.create':
      return { summary: t.memberCreate(action.avatar, action.name), details: [] };
    case 'member.update': {
      const details: string[] = [];
      if (action.before.name !== action.after.name) details.push(t.field(t.memberName, action.before.name, action.after.name));
      if (action.before.avatar !== action.after.avatar) details.push(t.field(t.avatar, action.before.avatar, action.after.avatar));
      return { summary: t.memberUpdate(action.after.name), details };
    }
    case 'member.delete':
      return { summary: t.memberDelete(action.name), details: [] };
    case 'expense.create':
      return { summary: t.expenseCreate(t.expenseLine(action.expense)), details: expenseDetails(t, action.expense, locale) };
    case 'expense.update':
      return { summary: t.expenseUpdate(action.after.title), details: expenseChanges(t, action.before, action.after, locale) };
    case 'expense.delete':
      return { summary: t.expenseDelete(t.expenseLine(action.expense)), details: [] };
    case 'settlement.create': {
      const { from, to, amount, note } = action.settlement;
      return { summary: t.settlementCreate(from, to, formatMoney(amount)), details: note ? [t.note(note)] : [] };
    }
    case 'settlement.delete': {
      const { from, to, amount } = action.settlement;
      return { summary: t.settlementDelete(from, to, formatMoney(amount)), details: [] };
    }
    case 'passphrase.create':
      return { summary: t.passphraseCreate(action.code), details: [action.validUntil ? t.validUntil(action.validUntil) : t.forever] };
    case 'passphrase.revoke':
      return { summary: t.passphraseRevoke(action.code), details: [] };
    case 'connection.create':
      return {
        summary: t.connectionCreate(client(action.client, action.host)),
        details: [action.scopes.includes('ledger:write') ? t.readWrite : t.readOnly],
      };
    case 'connection.revoke':
      return { summary: t.connectionRevoke(client(action.client, action.host)), details: [] };
  }
}
