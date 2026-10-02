import { z } from 'zod';
import { byNewest } from '../../shared/ledger.ts';
import { MAX_AMOUNT, type Cents } from '../../shared/money.ts';
import {
  expenseInput,
  isoDate,
  LIMITS,
  memberInput,
  settlementInput,
  type ExpenseInput,
} from '../../shared/schema.ts';
import { computeBalances, suggestTransfers } from '../../shared/settle.ts';
import type { Expense, LedgerData, LedgerInfo, LiveMessage, McpScope, Member, Settlement } from '../../shared/types.ts';
import { AppError, badRequest, notFound } from '../core/errors.ts';
import type { LedgerService } from '../core/ledger.ts';
import type { Remote } from '../core/remote.ts';

export interface ToolContext {
  ledger: Remote<LedgerService>;
  info: LedgerInfo;
  scopes: ReadonlySet<McpScope>;
  /** 写入实时事件的来源标记（mcp:客户端名），网页端据此提示「由 Claude 添加」 */
  origin: string;
  /** 配置时区下的今天（YYYY-MM-DD） */
  today: string;
}

interface Tool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** 需要 ledger:write 权限 */
  write: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  run(args: z.infer<S>, ctx: ToolContext): Promise<object>;
}

const tool = <S extends z.ZodObject>(t: Tool<S>) => t as unknown as Tool;

// ---------- 参数与格式 ----------

const yuan = (cents: Cents) => cents / 100;

const money = z
  .number()
  .positive('金额必须大于 0')
  .max(MAX_AMOUNT / 100, '金额过大')
  .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, '金额最多两位小数');
const toCents = (v: number) => Math.round(v * 100);

const memberRef = z.string().trim().min(1).max(64);
const date = isoDate.describe('日期 YYYY-MM-DD');
const recordId = z.string().trim().min(1).max(64);

/** 复用网页端的业务校验，错误信息保持一致 */
function validate<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(result.error.issues[0]?.message ?? '参数错误');
  return result.data;
}

/** 成员可以用 ID 或名字（不区分大小写）指代 */
function resolveMember(members: readonly Member[], ref: string): Member {
  const key = ref.trim();
  const found = members.find((m) => m.id === key) ?? members.find((m) => m.name.toLowerCase() === key.toLowerCase());
  if (found) return found;
  const names = members.map((m) => m.name).join('、');
  throw badRequest(`找不到成员「${ref}」。${names ? `现有成员：${names}` : '账本还没有成员，请先用 add_member 添加'}`);
}

function viewer(data: LedgerData) {
  const byId = new Map(data.members.map((m) => [m.id, m]));
  const name = (id: string) => byId.get(id)?.name ?? '（已删除成员）';
  return {
    member: (m: Member) => ({ id: m.id, name: m.name, avatar: m.avatar }),
    expense: (e: Expense) => ({
      type: 'expense' as const,
      id: e.id,
      date: e.date,
      title: e.title,
      amount: yuan(e.amount),
      payer: name(e.payerId),
      participants: e.shares.map((s) => ({ name: name(s.memberId), share: yuan(s.amount) })),
    }),
    settlement: (s: Settlement) => ({
      type: 'settlement' as const,
      id: s.id,
      date: s.date,
      from: name(s.fromId),
      to: name(s.toId),
      amount: yuan(s.amount),
      note: s.note,
    }),
  };
}

/** 从变更结果里取出保存后的实体 */
function saved<K extends 'expense' | 'settlement' | 'member'>(message: LiveMessage, key: K) {
  const event = message.event as Record<string, unknown>;
  return event[key] as K extends 'expense' ? Expense : K extends 'settlement' ? Settlement : Member;
}

// ---------- 工具 ----------

const getLedger = tool({
  name: 'get_ledger',
  title: '查看账本概况',
  description:
    '查看当前账本：成员列表、总支出、每人的垫付/应摊/净额，以及结清所需的最少转账方案。' +
    'net > 0 表示别人还欠 TA，net < 0 表示 TA 还欠别人。金额单位为人民币元。记账前建议先调用以获取成员名字。',
  input: z.object({}),
  write: false,
  async run(_, ctx) {
    const data = await ctx.ledger.snapshot();
    const v = viewer(data);
    const name = (id: string) => data.members.find((m) => m.id === id)?.name ?? '（已删除成员）';
    const balances = computeBalances(data.members, data.expenses, data.settlements);
    const dates = data.expenses.map((e) => e.date).sort();
    return {
      ledger: ctx.info.name,
      currency: 'CNY',
      today: ctx.today,
      permissions: [...ctx.scopes],
      members: data.members.map(v.member),
      summary: {
        expenseCount: data.expenses.length,
        totalSpent: yuan(data.expenses.reduce((sum, e) => sum + e.amount, 0)),
        settlementCount: data.settlements.length,
        firstDate: dates[0] ?? null,
        lastDate: dates.at(-1) ?? null,
      },
      balances: balances.map((b) => ({
        member: name(b.memberId),
        paid: yuan(b.paid),
        share: yuan(b.consumed),
        sent: yuan(b.sent),
        received: yuan(b.received),
        net: yuan(b.net),
      })),
      suggestedTransfers: suggestTransfers(balances).map((t) => ({ from: name(t.fromId), to: name(t.toId), amount: yuan(t.amount) })),
    };
  },
});

const listTransactions = tool({
  name: 'list_transactions',
  title: '查询账目',
  description: '按日期倒序列出支出与还款记录，可按日期范围、成员、类型和关键字筛选。返回的 id 可用于修改或删除。',
  input: z.object({
    from: date.optional().describe('起始日期（含），YYYY-MM-DD'),
    to: date.optional().describe('结束日期（含），YYYY-MM-DD'),
    member: memberRef.optional().describe('只看与该成员相关的账目（付款、参与分摊、还款），名字或 ID'),
    type: z.enum(['all', 'expense', 'settlement']).default('all').describe('账目类型'),
    query: z.string().trim().max(40).optional().describe('按用途或备注中的关键字筛选'),
    limit: z.number().int().min(1).max(200).default(50).describe('最多返回条数'),
  }),
  write: false,
  async run(args, ctx) {
    const data = await ctx.ledger.snapshot();
    const v = viewer(data);
    const member = args.member ? resolveMember(data.members, args.member) : null;
    const keyword = args.query?.toLowerCase();
    const inRange = (d: string) => (!args.from || d >= args.from) && (!args.to || d <= args.to);

    const expenses = args.type === 'settlement' ? [] : data.expenses.filter(
      (e) =>
        inRange(e.date) &&
        (!member || e.payerId === member.id || e.shares.some((s) => s.memberId === member.id)) &&
        (!keyword || e.title.toLowerCase().includes(keyword)),
    );
    const settlements = args.type === 'expense' ? [] : data.settlements.filter(
      (s) =>
        inRange(s.date) &&
        (!member || s.fromId === member.id || s.toId === member.id) &&
        (!keyword || (s.note ?? '').toLowerCase().includes(keyword)),
    );
    const items = [...expenses, ...settlements].sort(byNewest);
    return {
      matched: items.length,
      totalSpent: yuan(expenses.reduce((sum, e) => sum + e.amount, 0)),
      truncated: items.length > args.limit,
      items: items.slice(0, args.limit).map((x) => ('title' in x ? v.expense(x) : v.settlement(x))),
    };
  },
});

const addExpense = tool({
  name: 'add_expense',
  title: '记一笔支出',
  description:
    '记录一笔由某人垫付、多人平均分摊的支出（零头按成员加入顺序分配）。付款人和参与者用成员名字即可。' +
    '不填 participants 表示全部成员分摊，不填 date 表示今天。',
  input: z.object({
    title: z.string().describe(`用途，最多 ${LIMITS.title} 个字，如「午饭」「打车」`),
    amount: money.describe('金额，单位元，最多两位小数，如 128.5'),
    payer: memberRef.describe('付款人，名字或 ID'),
    participants: z.array(memberRef).min(1).max(LIMITS.members).optional().describe('参与分摊的成员（名字或 ID）；不填为全部成员'),
    date: date.optional().describe('记账日期 YYYY-MM-DD，不填为今天'),
  }),
  write: true,
  async run(args, ctx) {
    const data = await ctx.ledger.snapshot();
    const input = validate(expenseInput, {
      title: args.title,
      amount: toCents(args.amount),
      payerId: resolveMember(data.members, args.payer).id,
      participantIds: args.participants
        ? [...new Set(args.participants.map((p) => resolveMember(data.members, p).id))]
        : data.members.map((m) => m.id),
      date: args.date ?? ctx.today,
    } satisfies ExpenseInput);
    const message = await ctx.ledger.createExpense(input, ctx.origin);
    return { created: viewer(data).expense(saved(message, 'expense')) };
  },
});

const updateExpense = tool({
  name: 'update_expense',
  title: '修改支出',
  description: '修改一笔支出，只需提供要改的字段；participants 会整体替换分摊名单。id 来自 list_transactions。',
  input: z.object({
    id: recordId.describe('支出 ID'),
    title: z.string().optional().describe('新的用途'),
    amount: money.optional().describe('新的金额（元）'),
    payer: memberRef.optional().describe('新的付款人'),
    participants: z.array(memberRef).min(1).max(LIMITS.members).optional().describe('新的分摊成员名单'),
    date: date.optional().describe('新的日期'),
  }),
  write: true,
  idempotent: true,
  async run(args, ctx) {
    const data = await ctx.ledger.snapshot();
    const current = data.expenses.find((e) => e.id === args.id);
    if (!current) throw notFound('这笔支出不存在或已被删除');
    const input = validate(expenseInput, {
      title: args.title ?? current.title,
      amount: args.amount === undefined ? current.amount : toCents(args.amount),
      payerId: args.payer ? resolveMember(data.members, args.payer).id : current.payerId,
      participantIds: args.participants
        ? [...new Set(args.participants.map((p) => resolveMember(data.members, p).id))]
        : current.shares.map((s) => s.memberId),
      date: args.date ?? current.date,
    } satisfies ExpenseInput);
    const message = await ctx.ledger.updateExpense(args.id, input, ctx.origin);
    const v = viewer(data);
    return { before: v.expense(current), after: v.expense(saved(message, 'expense')) };
  },
});

const deleteExpense = tool({
  name: 'delete_expense',
  title: '删除支出',
  description: '删除一笔支出（不可恢复）。id 来自 list_transactions。',
  input: z.object({ id: recordId.describe('支出 ID') }),
  write: true,
  destructive: true,
  idempotent: true,
  async run(args, ctx) {
    const data = await ctx.ledger.snapshot();
    const current = data.expenses.find((e) => e.id === args.id);
    if (!current) throw notFound('这笔支出不存在或已被删除');
    await ctx.ledger.deleteExpense(args.id, ctx.origin);
    return { deleted: viewer(data).expense(current) };
  },
});

const addMember = tool({
  name: 'add_member',
  title: '添加成员',
  description: `向账本添加一位成员，名字最多 ${LIMITS.memberName} 个字且不能重名。`,
  input: z.object({
    name: z.string().describe('成员名字'),
    avatar: z.string().max(LIMITS.avatar).optional().describe('头像 emoji，不填随机'),
  }),
  write: true,
  async run(args, ctx) {
    const message = await ctx.ledger.createMember(validate(memberInput, args), ctx.origin);
    const m = saved(message, 'member');
    return { created: { id: m.id, name: m.name, avatar: m.avatar } };
  },
});

const updateMember = tool({
  name: 'update_member',
  title: '修改成员',
  description: '修改成员的名字或头像。',
  input: z.object({
    member: memberRef.describe('要修改的成员，名字或 ID'),
    name: z.string().optional().describe('新名字'),
    avatar: z.string().max(LIMITS.avatar).optional().describe('新头像 emoji'),
  }),
  write: true,
  idempotent: true,
  async run(args, ctx) {
    const data = await ctx.ledger.snapshot();
    const current = resolveMember(data.members, args.member);
    const input = validate(memberInput, { name: args.name ?? current.name, avatar: args.avatar ?? current.avatar });
    const m = saved(await ctx.ledger.updateMember(current.id, input, ctx.origin), 'member');
    return { updated: { id: m.id, name: m.name, avatar: m.avatar } };
  },
});

const recordSettlement = tool({
  name: 'record_settlement',
  title: '记录还款',
  description:
    '记录一笔还款：from 已经把钱转给了 to。常用于按 get_ledger 的 suggestedTransfers 结清账目。不填 date 表示今天。',
  input: z.object({
    from: memberRef.describe('付款（还钱）的人'),
    to: memberRef.describe('收款的人'),
    amount: money.describe('金额（元）'),
    date: date.optional().describe('日期 YYYY-MM-DD，不填为今天'),
    note: z.string().max(LIMITS.note).optional().describe('备注，如「微信转账」'),
  }),
  write: true,
  async run(args, ctx) {
    const data = await ctx.ledger.snapshot();
    const input = validate(settlementInput, {
      fromId: resolveMember(data.members, args.from).id,
      toId: resolveMember(data.members, args.to).id,
      amount: toCents(args.amount),
      date: args.date ?? ctx.today,
      note: args.note ?? null,
    });
    const message = await ctx.ledger.createSettlement(input, ctx.origin);
    return { created: viewer(data).settlement(saved(message, 'settlement')) };
  },
});

const deleteSettlement = tool({
  name: 'delete_settlement',
  title: '撤销还款',
  description: '删除一笔还款记录（撤销「已付」）。id 来自 list_transactions。',
  input: z.object({ id: recordId.describe('还款记录 ID') }),
  write: true,
  destructive: true,
  idempotent: true,
  async run(args, ctx) {
    const data = await ctx.ledger.snapshot();
    const current = data.settlements.find((s) => s.id === args.id);
    if (!current) throw notFound('这笔还款不存在或已被删除');
    await ctx.ledger.deleteSettlement(args.id, ctx.origin);
    return { deleted: viewer(data).settlement(current) };
  },
});

const TOOLS = [
  getLedger,
  listTransactions,
  addExpense,
  updateExpense,
  deleteExpense,
  addMember,
  updateMember,
  recordSettlement,
  deleteSettlement,
];

const allowed = (t: Tool, scopes: ReadonlySet<McpScope>) => scopes.has(t.write ? 'ledger:write' : 'ledger:read');

function inputSchema(t: Tool) {
  const { $schema: _, ...schema } = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' });
  return schema;
}

/** tools/list：只列出当前授权可用的工具 */
export function listTools(scopes: ReadonlySet<McpScope>) {
  return TOOLS.filter((t) => allowed(t, scopes)).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: inputSchema(t),
    annotations: {
      title: t.title,
      readOnlyHint: !t.write,
      destructiveHint: !!t.destructive,
      idempotentHint: !t.write || !!t.idempotent,
      openWorldHint: false,
    },
  }));
}

export class UnknownToolError extends Error {}

/** tools/call：业务错误作为工具结果（isError）返回，模型可据此自行修正 */
export async function callTool(name: string, args: unknown, ctx: ToolContext) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new UnknownToolError(`未知工具 ${name}`);
  const fail = (text: string) => ({ content: [{ type: 'text', text }], isError: true });
  if (!allowed(t, ctx.scopes)) return fail('当前授权为只读，无法修改账目。请在 AI 应用中重新连接并允许修改。');

  const parsed = t.input.safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(`参数错误：${issue?.path.join('.') || '参数'} ${issue?.message ?? ''}`.trim());
  }
  try {
    const result = await t.run(parsed.data, ctx);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (err) {
    if (err instanceof AppError) return fail(err.message);
    throw err;
  }
}
