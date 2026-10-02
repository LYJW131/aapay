import type { AuditAction, AuditActor, AuditExpense } from './audit.ts';
import { formatMoney } from './money.ts';

export function actorLabel(actor: AuditActor): string {
  switch (actor.kind) {
    case 'member':
      return actor.passphrase ? `成员（口令 ${actor.passphrase}）` : '成员';
    case 'admin':
      return `管理员 ${actor.name}`;
    case 'shared':
      return '访客';
    case 'ai':
      return `${actor.client ?? 'AI 应用'}${actor.host ? `（${actor.host}）` : ''}${actor.verified ? '' : ' · 名称未验证'}`;
  }
}

function expenseLine(e: AuditExpense) {
  return `「${e.title}」${formatMoney(e.amount)}，${e.payer} 付，${e.participants.length} 人分摊（${e.date}）`;
}

function expenseChanges(before: AuditExpense, after: AuditExpense) {
  const changes: string[] = [];
  if (before.title !== after.title) changes.push(`用途：${before.title} → ${after.title}`);
  if (before.amount !== after.amount) changes.push(`金额：${formatMoney(before.amount)} → ${formatMoney(after.amount)}`);
  if (before.payer !== after.payer) changes.push(`付款人：${before.payer} → ${after.payer}`);
  if (before.date !== after.date) changes.push(`日期：${before.date} → ${after.date}`);
  if (before.participants.join('、') !== after.participants.join('、')) {
    changes.push(`分摊：${before.participants.join('、')} → ${after.participants.join('、')}`);
  }
  return changes;
}

export function describeAudit(action: AuditAction): { summary: string; details: string[] } {
  switch (action.type) {
    case 'ledger.create':
      return { summary: `创建了账本 ${action.emoji ? `${action.emoji} ` : ''}「${action.name}」`, details: [] };
    case 'ledger.rename':
      return { summary: `把账本「${action.from}」改名为「${action.to}」`, details: [] };
    case 'ledger.update': {
      const details: string[] = [];
      if (action.before.name !== action.after.name) details.push(`名称：${action.before.name} → ${action.after.name}`);
      if (action.before.emoji !== action.after.emoji) details.push(`图标：${action.before.emoji} → ${action.after.emoji}`);
      return { summary: `修改了账本「${action.after.name}」`, details };
    }
    case 'member.create':
      return { summary: `添加了成员 ${action.avatar} ${action.name}`, details: [] };
    case 'member.update': {
      const details: string[] = [];
      if (action.before.name !== action.after.name) details.push(`名字：${action.before.name} → ${action.after.name}`);
      if (action.before.avatar !== action.after.avatar) details.push(`头像：${action.before.avatar} → ${action.after.avatar}`);
      return { summary: `修改了成员 ${action.after.name}`, details };
    }
    case 'member.delete':
      return { summary: `移除了成员 ${action.name}`, details: [] };
    case 'expense.create':
      return { summary: `记了一笔${expenseLine(action.expense)}`, details: [] };
    case 'expense.update':
      return { summary: `修改了「${action.after.title}」`, details: expenseChanges(action.before, action.after) };
    case 'expense.delete':
      return { summary: `删除了${expenseLine(action.expense)}`, details: [] };
    case 'settlement.create':
      return {
        summary: `记录还款：${action.settlement.from} → ${action.settlement.to} ${formatMoney(action.settlement.amount)}`,
        details: action.settlement.note ? [`备注：${action.settlement.note}`] : [],
      };
    case 'settlement.delete':
      return { summary: `撤销了还款：${action.settlement.from} → ${action.settlement.to} ${formatMoney(action.settlement.amount)}`, details: [] };
    case 'passphrase.create':
      return {
        summary: `生成了分享口令 ${action.code}`,
        details: [action.validUntil ? `有效期至 ${new Date(action.validUntil).toLocaleString('zh-CN', { hour12: false })}` : '永久有效'],
      };
    case 'passphrase.revoke':
      return { summary: `撤销了分享口令 ${action.code}`, details: [] };
    case 'connection.create':
      return {
        summary: `授权 ${action.client ?? 'AI 应用'}${action.host ? `（${action.host}）` : ''} 连接本账本`,
        details: [action.scopes.includes('ledger:write') ? '可以查看和记账' : '只读'],
      };
    case 'connection.revoke':
      return { summary: `断开了 ${action.client ?? 'AI 应用'}${action.host ? `（${action.host}）` : ''} 的连接`, details: [] };
  }
}
