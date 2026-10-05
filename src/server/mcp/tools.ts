import { z } from 'zod';
import { byNewest } from '../../shared/ledger.ts';
import { MAX_AMOUNT, type Cents } from '../../shared/money.ts';
import { actorLabel, describeAudit } from '../../shared/audit-text.ts';
import { parseAudit, type AuditActor } from '../../shared/audit.ts';
import { isPlainErrorKey, translateError } from '../../shared/errors.ts';
import { DEFAULT_LOCALE } from '../../shared/i18n.ts';
import { randomPassphrase } from '../../shared/passphrase.ts';
import {
  expenseInput,
  isoDate,
  ledgerInput,
  LIMITS,
  memberInput,
  passphraseInput,
  settlementInput,
  type ExpenseInput,
} from '../../shared/schema.ts';
import { computeBalances, suggestTransfers } from '../../shared/settle.ts';
import type {
  Expense,
  LedgerData,
  LedgerInfo,
  LiveMessage,
  McpScope,
  Member,
  Passphrase,
  Settlement,
} from '../../shared/types.ts';
import { adminActions } from '../admin.ts';
import { AppError, notFound } from '../core/errors.ts';
import type { LedgerService, MutationContext } from '../core/ledger.ts';
import type { GrantRole } from '../core/registry.ts';
import type { Remote } from '../core/remote.ts';
import type { Platform } from '../platform.ts';

export interface ToolContext {
  ledger: Remote<LedgerService>;
  info: LedgerInfo;
  scopes: ReadonlySet<McpScope>;
  mutation: MutationContext;
  today: string;
}

interface Tool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  write: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  run(args: z.infer<S>, ctx: ToolContext): Promise<object>;
}

const tool = <S extends z.ZodObject>(t: Tool<S>) => t as unknown as Tool;

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

class ToolError extends Error {}

const issueText = (message: string | undefined) =>
  message === undefined ? translateError(DEFAULT_LOCALE, 'invalidParams') : isPlainErrorKey(message) ? translateError(DEFAULT_LOCALE, message) : message;

// 复用网页端的 zod 校验，错误信息保持一致
function validate<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ToolError(issueText(result.error.issues[0]?.message));
  return result.data;
}

function resolveMember(members: readonly Member[], ref: string): Member {
  const key = ref.trim();
  const found = members.find((m) => m.id === key) ?? members.find((m) => m.name.toLowerCase() === key.toLowerCase());
  if (found) return found;
  const names = members.map((m) => m.name).join('、');
  throw new ToolError(`找不到成员「${ref}」。${names ? `现有成员：${names}` : '账本还没有成员，请先用 add_member 添加'}`);
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

function saved<K extends 'expense' | 'settlement' | 'member'>(message: LiveMessage, key: K) {
  const event = message.event as Record<string, unknown>;
  return event[key] as K extends 'expense' ? Expense : K extends 'settlement' ? Settlement : Member;
}

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

const listActivity = tool({
  name: 'list_activity',
  title: '查看操作记录',
  description: '按时间倒序查看账本的操作审计日志：谁在什么时候记账、修改、删除、还款，以及口令和 AI 连接的变化。日志只能追加、带哈希链与签名，不可篡改。',
  input: z.object({
    limit: z.number().int().min(1).max(100).default(30).describe('最多返回条数'),
    before: z.number().int().positive().optional().describe('只看序号小于此值的记录，用于向前翻页'),
  }),
  write: false,
  async run(args, ctx) {
    const page = await ctx.ledger.auditLog({ before: args.before, limit: args.limit });
    return {
      total: page.head?.seq ?? 0,
      signed: page.publicKey !== null,
      entries: page.records.map((r) => {
        const { seq, at, actor, action } = parseAudit(r);
        const { summary, details } = describeAudit(action, DEFAULT_LOCALE);
        return { seq, at: new Date(at).toISOString(), actor: actorLabel(actor, DEFAULT_LOCALE), summary, details };
      }),
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
    const message = await ctx.ledger.createExpense(input, ctx.mutation);
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
    if (!current) throw notFound('expenseNotFound');
    const input = validate(expenseInput, {
      title: args.title ?? current.title,
      amount: args.amount === undefined ? current.amount : toCents(args.amount),
      payerId: args.payer ? resolveMember(data.members, args.payer).id : current.payerId,
      participantIds: args.participants
        ? [...new Set(args.participants.map((p) => resolveMember(data.members, p).id))]
        : current.shares.map((s) => s.memberId),
      date: args.date ?? current.date,
    } satisfies ExpenseInput);
    const message = await ctx.ledger.updateExpense(args.id, input, ctx.mutation);
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
    if (!current) throw notFound('expenseNotFound');
    await ctx.ledger.deleteExpense(args.id, ctx.mutation);
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
    const message = await ctx.ledger.createMember(validate(memberInput, args), ctx.mutation);
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
    const m = saved(await ctx.ledger.updateMember(current.id, input, ctx.mutation), 'member');
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
    const message = await ctx.ledger.createSettlement(input, ctx.mutation);
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
    if (!current) throw notFound('settlementNotFound');
    await ctx.ledger.deleteSettlement(args.id, ctx.mutation);
    return { deleted: viewer(data).settlement(current) };
  },
});

const LEDGER_TOOLS = [
  getLedger,
  listTransactions,
  listActivity,
  addExpense,
  updateExpense,
  deleteExpense,
  addMember,
  updateMember,
  recordSettlement,
  deleteSettlement,
];

export interface McpSession {
  role: GrantRole;
  ledger: LedgerInfo | null;
  scopes: ReadonlySet<McpScope>;
  actor: AuditActor;
  // 网页端按 mcp: 前缀识别并提示是哪个 AI 应用改的
  origin: string;
  today: string;
  baseUrl: string;
  platform: Platform;
}

interface AdminContext {
  session: McpSession;
  actions: ReturnType<typeof adminActions>;
}

interface AdminTool<S extends z.ZodObject = z.ZodObject> extends Omit<Tool<S>, 'run'> {
  run(args: z.infer<S>, ctx: AdminContext): Promise<object>;
}

const adminTool = <S extends z.ZodObject>(t: AdminTool<S>) => t as unknown as AdminTool;

const ledgerRef = z.string().trim().min(1).max(64).describe('账本名称或 ID（可用 list_ledgers 查看）');
const ledgerOption = ledgerRef
  .optional()
  .describe('账本名称或 ID。管理员授权必填（可用 list_ledgers 查看）；成员授权只能访问授权时选定的账本，可不填');

async function resolveLedger(platform: Platform, ref: string | undefined): Promise<LedgerInfo> {
  const ledgers = await platform.registry.listLedgers();
  const key = ref?.trim();
  const found = key && (ledgers.find((l) => l.id === key) ?? ledgers.find((l) => l.name.toLowerCase() === key.toLowerCase()));
  if (found) return { id: found.id, name: found.name, emoji: found.emoji };
  const names = ledgers.map((l) => `「${l.name}」`).join('');
  const hint = names ? `现有账本：${names}` : '还没有任何账本，可以用 create_ledger 创建';
  throw new ToolError(key ? `找不到账本「${ref}」。${hint}` : `管理员授权需要用 ledger 参数指定账本。${hint}`);
}

async function targetLedger(session: McpSession, ref: string | undefined): Promise<LedgerInfo> {
  if (session.role === 'admin') return resolveLedger(session.platform, ref);
  const bound = session.ledger!;
  if (ref !== undefined && ref !== bound.id && ref.toLowerCase() !== bound.name.toLowerCase()) {
    throw new ToolError(`当前连接只授权了账本「${bound.name}」，不能访问「${ref}」`);
  }
  return bound;
}

const isoDay = (ts: number | null) => (ts === null ? null : new Date(ts).toISOString().slice(0, 10));

function passphraseView(p: Passphrase, baseUrl: string) {
  const now = Date.now();
  const status = p.validFrom > now ? 'pending' : p.validUntil !== null && p.validUntil <= now ? 'expired' : 'active';
  return {
    code: p.code,
    status,
    validFrom: new Date(p.validFrom).toISOString(),
    validUntil: p.validUntil === null ? null : new Date(p.validUntil).toISOString(),
    joinLink: `${baseUrl}/join#${encodeURIComponent(p.code)}`,
  };
}

const validDays = z.number().int().min(1).max(3650).optional().describe('有效天数；不填为永久有效');

async function createPassphrase(ctx: AdminContext, ledgerId: string, code: string | undefined, days: number | undefined) {
  const now = Date.now();
  const input = validate(passphraseInput, {
    code: code ?? randomPassphrase(),
    validFrom: now,
    validUntil: days === undefined ? null : now + days * 86_400_000,
  });
  return passphraseView(await ctx.actions.createPassphrase(ledgerId, input), ctx.session.baseUrl);
}

const listLedgers = adminTool({
  name: 'list_ledgers',
  title: '列出全部账本',
  description: '列出所有账本及其成员数、支出笔数、总支出（元）、生效中的口令数和已连接的 AI 应用数。',
  input: z.object({}),
  write: false,
  async run(_, ctx) {
    const ledgers = await ctx.actions.listLedgers();
    return {
      ledgers: ledgers.map((l) => ({
        id: l.id,
        name: l.name,
        emoji: l.emoji,
        createdAt: isoDay(l.createdAt),
        members: l.stats?.members ?? null,
        expenses: l.stats?.expenses ?? null,
        totalSpent: l.stats ? yuan(l.stats.total) : null,
        lastActivity: isoDay(l.stats?.lastActivityAt ?? null),
        activePassphrases: l.activePassphrases,
        aiConnections: l.connections,
      })),
    };
  },
});

const createLedger = adminTool({
  name: 'create_ledger',
  title: '创建账本',
  description: '创建一个新账本，默认同时生成一个分享口令并返回邀请链接，发给朋友即可加入。',
  input: z.object({
    name: z.string().describe(`账本名称，最多 ${LIMITS.ledgerName} 个字，不能与已有账本重名`),
    emoji: z.string().optional().describe('账本图标（一个 emoji）；不填随机挑一个'),
    create_passphrase: z.boolean().default(true).describe('是否同时生成分享口令'),
    passphrase: z.string().optional().describe(`自定义口令（${LIMITS.codeMin}-${LIMITS.codeMax} 位字母或数字）；不填随机生成`),
    valid_days: validDays,
  }),
  write: true,
  async run(args, ctx) {
    const ledger = await ctx.actions.createLedger(validate(ledgerInput, { name: args.name, emoji: args.emoji }));
    const passphrase = args.create_passphrase ? await createPassphrase(ctx, ledger.id, args.passphrase, args.valid_days) : null;
    return { created: { id: ledger.id, name: ledger.name, emoji: ledger.emoji }, passphrase };
  },
});

const updateLedger = adminTool({
  name: 'update_ledger',
  title: '修改账本',
  description: '修改账本名称或图标，正在查看该账本的成员会立即看到。',
  input: z.object({
    ledger: ledgerRef,
    name: z.string().optional().describe('新名称；不填保持不变'),
    emoji: z.string().optional().describe('新图标（一个 emoji）；不填保持不变'),
  }),
  write: true,
  idempotent: true,
  async run(args, ctx) {
    const target = await resolveLedger(ctx.session.platform, args.ledger);
    const input = validate(ledgerInput, { name: args.name ?? target.name, emoji: args.emoji ?? target.emoji });
    return { updated: await ctx.actions.updateLedger(target.id, input), before: target };
  },
});

const deleteLedger = adminTool({
  name: 'delete_ledger',
  title: '删除账本',
  description: '永久删除一个账本及其全部账目、口令和 AI 连接，不可恢复。为防误删，confirm_name 必须与账本名称完全一致。',
  input: z.object({ ledger: ledgerRef, confirm_name: z.string().describe('再次输入要删除的账本名称以确认') }),
  write: true,
  destructive: true,
  async run(args, ctx) {
    const target = await resolveLedger(ctx.session.platform, args.ledger);
    if (args.confirm_name.trim() !== target.name) {
      throw new ToolError(`确认名称不一致：要删除的账本叫「${target.name}」。请向用户确认后，把 confirm_name 设为该名称`);
    }
    return { deleted: await ctx.actions.deleteLedger(target.id) };
  },
});

const listPassphrases = adminTool({
  name: 'list_passphrases',
  title: '查看分享口令',
  description: '查看某个账本的全部分享口令、有效期状态（active / pending / expired）与邀请链接。',
  input: z.object({ ledger: ledgerRef }),
  write: false,
  async run(args, ctx) {
    const target = await resolveLedger(ctx.session.platform, args.ledger);
    const list = await ctx.session.platform.registry.listPassphrases(target.id);
    return { ledger: target.name, passphrases: list.map((p) => passphraseView(p, ctx.session.baseUrl)) };
  },
});

const createPassphraseTool = adminTool({
  name: 'create_passphrase',
  title: '生成分享口令',
  description: '为账本生成一个分享口令，返回口令与邀请链接（打开链接即可加入账本）。',
  input: z.object({
    ledger: ledgerRef,
    code: z.string().optional().describe(`自定义口令（${LIMITS.codeMin}-${LIMITS.codeMax} 位字母或数字）；不填随机生成`),
    valid_days: validDays,
  }),
  write: true,
  async run(args, ctx) {
    const target = await resolveLedger(ctx.session.platform, args.ledger);
    return { ledger: target.name, created: await createPassphrase(ctx, target.id, args.code, args.valid_days) };
  },
});

const revokePassphrase = adminTool({
  name: 'revoke_passphrase',
  title: '撤销分享口令',
  description: '撤销一个分享口令：用它加入的成员会话和 AI 连接会立即失效。',
  input: z.object({ ledger: ledgerRef, code: z.string().trim().min(1).describe('要撤销的口令') }),
  write: true,
  destructive: true,
  idempotent: true,
  async run(args, ctx) {
    const target = await resolveLedger(ctx.session.platform, args.ledger);
    const list = await ctx.session.platform.registry.listPassphrases(target.id);
    const found = list.find((p) => p.code.toLowerCase() === args.code.toLowerCase());
    if (!found) throw new ToolError(`账本「${target.name}」没有口令「${args.code}」`);
    await ctx.actions.revokePassphrase(found.id);
    return { revoked: found.code, ledger: target.name };
  },
});

const ADMIN_TOOLS = [listLedgers, createLedger, updateLedger, deleteLedger, listPassphrases, createPassphraseTool, revokePassphrase];

type AnyTool = { kind: 'ledger'; tool: Tool; input: z.ZodObject } | { kind: 'admin'; tool: AdminTool; input: z.ZodObject };

const TOOLS: AnyTool[] = [
  ...LEDGER_TOOLS.map((tool) => ({ kind: 'ledger' as const, tool, input: tool.input.extend({ ledger: ledgerOption }) })),
  ...ADMIN_TOOLS.map((tool) => ({ kind: 'admin' as const, tool, input: tool.input })),
];

const findTool = (name: string) => TOOLS.find((e) => e.tool.name === name);

const permitted = (entry: AnyTool, session: McpSession) => entry.kind === 'ledger' || session.role === 'admin';

function inputSchema(schema: z.ZodObject) {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  return json;
}

// 客户端会缓存工具列表，换授权后未必重新拉取，所以列表对所有授权都相同，权限在调用时检查
export const TOOL_LIST = TOOLS.map(({ kind, tool, input }) => ({
  name: tool.name,
  title: tool.title,
  description: kind === 'admin' ? `${tool.description}仅管理员授权可用。` : tool.description,
  inputSchema: inputSchema(input),
  annotations: {
    title: tool.title,
    readOnlyHint: !tool.write,
    destructiveHint: !!tool.destructive,
    idempotentHint: !tool.write || !!tool.idempotent,
    openWorldHint: false,
  },
  securitySchemes: [{ type: 'oauth2', scopes: [tool.write ? 'ledger:write' : 'ledger:read'] }],
}));

export function missingWriteScope(name: string, session: McpSession) {
  const entry = findTool(name);
  return !!entry && entry.tool.write && permitted(entry, session) && !session.scopes.has('ledger:write');
}

export class UnknownToolError extends Error {}

// 业务错误作为工具结果（isError）返回而非协议错误，模型可据此自行修正
export async function callTool(name: string, args: unknown, session: McpSession) {
  const fail = (text: string) => ({ content: [{ type: 'text', text }], isError: true });
  const entry = findTool(name);
  if (!entry) throw new UnknownToolError(`未知工具 ${name}`);
  if (!permitted(entry, session)) {
    return fail(
      `${name} 是管理员工具，当前连接只授权了账本「${session.ledger!.name}」。` +
        '如需管理全部账本，请在 AI 应用中重新连接 AAPay，并在授权页以管理员身份授权（选择「全部账本」）。',
    );
  }

  const parsed = entry.input.safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(`参数错误：${issue?.path.join('.') || '参数'} ${issue ? issueText(issue.message) : ''}`.trim());
  }
  try {
    let result: object;
    if (entry.kind === 'admin') {
      result = await entry.tool.run(parsed.data, { session, actions: adminActions(session.platform, session.actor) });
    } else {
      const info = await targetLedger(session, (parsed.data as { ledger?: string }).ledger);
      result = await entry.tool.run(parsed.data, {
        ledger: session.platform.ledger(info.id).api,
        info,
        scopes: session.scopes,
        mutation: { actor: session.actor, origin: session.origin },
        today: session.today,
      });
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (err) {
    if (err instanceof AppError || err instanceof ToolError) return fail(err.message);
    throw err;
  }
}
