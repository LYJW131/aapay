import { z } from 'zod';
import { actorLabel, describeAudit } from '../../shared/audit-text.ts';
import { parseAudit, type AuditPage } from '../../shared/audit.ts';
import { CATEGORIES, CATEGORY_LABELS, guessCategory, type Category } from '../../shared/categories.ts';
import type { Change } from '../../shared/changes.ts';
import { isPlainErrorKey, translateError, type PlainErrorKey } from '../../shared/errors.ts';
import type { Locale } from '../../shared/i18n.ts';
import { newId } from '../../shared/ids.ts';
import { byNewest, splitOf } from '../../shared/ledger.ts';
import { MAX_AMOUNT, splitByWeights, type Cents } from '../../shared/money.ts';
import { expenseInput, isoDate, LIMITS, memberInput, settlementInput, type ExpenseSplit } from '../../shared/schema.ts';
import { computeBalances, suggestTransfers } from '../../shared/settle.ts';
import type { Expense, LedgerData, LedgerInfo, McpScope, Member, Settlement } from '../../shared/types.ts';
import { AVATARS } from '../core/ledger.ts';

export const TOOL_LOCALE: Locale = 'en';

export class ToolError extends Error {}

export interface ReadContext {
  data: LedgerData;
  info: LedgerInfo;
  today: string;
  permissions?: readonly McpScope[];
  auditLog(query: { before?: number; limit: number }): AuditPage | Promise<AuditPage>;
}

export interface PlanContext {
  data: LedgerData;
  today: string;
}

interface ToolBase<S extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  destructive?: boolean;
  idempotent?: boolean;
}

export interface ReadTool<S extends z.ZodObject = z.ZodObject> extends ToolBase<S> {
  write: false;
  read(args: z.infer<S>, ctx: ReadContext): object | Promise<object>;
}

export interface WriteTool<S extends z.ZodObject = z.ZodObject> extends ToolBase<S> {
  write: true;
  plan(args: z.infer<S>, ctx: PlanContext): Change;
  describe(change: Change, before: LedgerData, after: LedgerData): object;
}

export type LedgerTool = ReadTool | WriteTool;

const readTool = <S extends z.ZodObject>(t: ReadTool<S>) => t as unknown as ReadTool;
const writeTool = <S extends z.ZodObject>(t: WriteTool<S>) => t as unknown as WriteTool;

export const yuan = (cents: Cents) => cents / 100;
export const toCents = (v: number) => Math.round(v * 100);

export const money = z
  .number()
  .positive('amount must be greater than 0')
  .max(MAX_AMOUNT / 100, 'amount is too large')
  .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, 'amount can have at most two decimal places');

export const memberRef = z.string().trim().min(1).max(64);
const date = isoDate.describe('Date, YYYY-MM-DD');
const recordId = z.string().trim().min(1).max(64);
const categoryArg = z.enum(CATEGORIES);

export const fail = (key: PlainErrorKey) => new ToolError(translateError(TOOL_LOCALE, key));

export const issueText = (message: string | undefined) =>
  message === undefined ? translateError(TOOL_LOCALE, 'invalidParams') : isPlainErrorKey(message) ? translateError(TOOL_LOCALE, message) : message;

export function inputSchema(schema: z.ZodType): object {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  return json;
}

export function parseArgs<T extends z.ZodType>(schema: T, args: unknown): z.infer<T> {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new ToolError(`Invalid arguments: ${issue?.path.join('.') || 'input'} ${issue ? issueText(issue.message) : ''}`.trim());
}

export function validate<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ToolError(issueText(result.error.issues[0]?.message));
  return result.data;
}

export function resolveMember(members: readonly Member[], ref: string): Member {
  const key = ref.trim();
  const found = members.find((m) => m.id === key) ?? members.find((m) => m.name.toLowerCase() === key.toLowerCase());
  if (found) return found;
  const names = members.map((m) => m.name).join(', ');
  throw new ToolError(`No member named "${ref}". ${names ? `Members: ${names}` : 'The ledger has no members yet; add one with add_member first'}`);
}

export function viewer(data: LedgerData) {
  const byId = new Map(data.members.map((m) => [m.id, m]));
  const name = (id: string) => byId.get(id)?.name ?? '(deleted member)';
  return {
    name,
    member: (m: Member) => ({ id: m.id, name: m.name, avatar: m.avatar }),
    expense: (e: Expense) => ({
      type: 'expense' as const,
      id: e.id,
      date: e.date,
      title: e.title,
      amount: yuan(e.amount),
      category: e.category,
      payer: name(e.payerId),
      split: splitOf(e, data.members).mode === 'even' ? ('even' as const) : ('custom' as const),
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

const find = <T extends { id: string }>(list: readonly T[], id: string) => list.find((x) => x.id === id);

const shareArg = z.object({
  member: memberRef.describe('Member name or ID'),
  amount: money.optional().describe('This member’s share in CNY; give every share an amount, adding up to the total'),
  weight: z.number().int().min(1).max(1000).optional().describe('This member’s number of portions, e.g. 2 for someone who ate double; give every share a weight'),
});

type ShareArg = z.infer<typeof shareArg>;

function planSplit(members: readonly Member[], amount: Cents, participants: string[] | undefined, shares: ShareArg[] | undefined): ExpenseSplit | null {
  if (participants && shares) throw new ToolError('Pass either participants (even split) or shares (custom split), not both');
  if (participants) return { mode: 'even', memberIds: [...new Set(participants.map((p) => resolveMember(members, p).id))] };
  if (!shares) return null;
  const resolved = shares.map((s) => ({ ...s, member: resolveMember(members, s.member) }));
  const seen = new Set<string>();
  for (const { member } of resolved) {
    if (seen.has(member.id)) throw new ToolError(`${member.name} appears more than once in shares`);
    seen.add(member.id);
  }
  if (resolved.every((s) => s.amount !== undefined && s.weight === undefined)) {
    const list = resolved.map((s) => ({ memberId: s.member.id, amount: toCents(s.amount!) }));
    const sum = list.reduce((acc, s) => acc + s.amount, 0);
    if (sum !== amount) throw new ToolError(`Shares add up to ${yuan(sum)} but the amount is ${yuan(amount)}`);
    return splitOf({ amount, shares: list }, members);
  }
  if (resolved.every((s) => s.weight !== undefined && s.amount === undefined)) {
    const list = splitByWeights(amount, resolved.map((s) => ({ memberId: s.member.id, weight: s.weight! })));
    if (list.some((s) => s.amount < 1)) throw new ToolError('The amount is too small to split by these weights');
    return splitOf({ amount, shares: list }, members);
  }
  throw new ToolError('Give every share either an amount (CNY) or a weight, not a mix');
}

const SPLIT_HELP =
  'Split: omit participants and shares to split evenly among all members; participants splits evenly among those members (leftover cents go to members in join order); ' +
  'shares sets a custom split, either every share with an amount (CNY, adding up to the total) or every share with a weight (portions). participants and shares cannot be combined.';

const CATEGORY_HELP = `Category, one of: ${CATEGORIES.join(', ')}`;

const getLedger = readTool({
  name: 'get_ledger',
  title: 'Get ledger overview',
  description:
    'Show the ledger: members, total spent, spending by category, what each member paid / owes / nets, and the minimal set of transfers to settle up. ' +
    'net > 0 means others owe this member; net < 0 means this member owes others. Amounts are in CNY. Call this before recording expenses to learn member names.',
  input: z.object({}),
  write: false,
  read(_, { data, info, today, permissions }) {
    const v = viewer(data);
    const balances = computeBalances(data.members, data.expenses, data.settlements);
    const dates = data.expenses.map((e) => e.date).sort();
    const groups = new Map<Category | null, { count: number; total: Cents }>();
    for (const e of data.expenses) {
      const g = groups.get(e.category) ?? { count: 0, total: 0 };
      groups.set(e.category, { count: g.count + 1, total: g.total + e.amount });
    }
    return {
      ledger: info.name,
      currency: 'CNY',
      today,
      ...(permissions && { permissions: [...permissions] }),
      members: data.members.map(v.member),
      summary: {
        expenseCount: data.expenses.length,
        totalSpent: yuan(data.expenses.reduce((sum, e) => sum + e.amount, 0)),
        settlementCount: data.settlements.length,
        firstDate: dates[0] ?? null,
        lastDate: dates.at(-1) ?? null,
      },
      byCategory: [...groups]
        .sort((a, b) => b[1].total - a[1].total)
        .map(([category, g]) => ({
          category: category ?? 'uncategorized',
          label: category ? CATEGORY_LABELS[TOOL_LOCALE][category] : 'Uncategorized',
          count: g.count,
          total: yuan(g.total),
        })),
      balances: balances.map((b) => ({
        member: v.name(b.memberId),
        paid: yuan(b.paid),
        share: yuan(b.consumed),
        sent: yuan(b.sent),
        received: yuan(b.received),
        net: yuan(b.net),
      })),
      suggestedTransfers: suggestTransfers(balances).map((t) => ({ from: v.name(t.fromId), to: v.name(t.toId), amount: yuan(t.amount) })),
    };
  },
});

const listTransactions = readTool({
  name: 'list_transactions',
  title: 'List transactions',
  description:
    'List expenses and settlements, newest first, optionally filtered by date range, member, type, category and keyword. Expenses include their category and each member’s share. The returned ids can be used to update or delete records.',
  input: z.object({
    from: date.optional().describe('Start date (inclusive), YYYY-MM-DD'),
    to: date.optional().describe('End date (inclusive), YYYY-MM-DD'),
    member: memberRef.optional().describe('Only records involving this member (paid, shared, or settled), by name or ID'),
    type: z.enum(['all', 'expense', 'settlement']).default('all').describe('Record type'),
    category: z.enum([...CATEGORIES, 'uncategorized']).optional().describe('Only expenses in this category; uncategorized matches expenses without one'),
    query: z.string().trim().max(40).optional().describe('Keyword to match in the expense description or settlement note'),
    limit: z.number().int().min(1).max(200).default(50).describe('Maximum number of records to return'),
  }),
  write: false,
  read(args, { data }) {
    const v = viewer(data);
    const member = args.member ? resolveMember(data.members, args.member) : null;
    const keyword = args.query?.toLowerCase();
    const inRange = (d: string) => (!args.from || d >= args.from) && (!args.to || d <= args.to);
    const category = args.category === 'uncategorized' ? null : args.category;

    const expenses =
      args.type === 'settlement'
        ? []
        : data.expenses.filter(
            (e) =>
              inRange(e.date) &&
              (category === undefined || e.category === category) &&
              (!member || e.payerId === member.id || e.shares.some((s) => s.memberId === member.id)) &&
              (!keyword || e.title.toLowerCase().includes(keyword)),
          );
    const settlements =
      args.type === 'expense' || category !== undefined
        ? []
        : data.settlements.filter(
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

const listActivity = readTool({
  name: 'list_activity',
  title: 'List activity',
  description:
    'Show the ledger audit log, newest first: who added, edited or deleted expenses, recorded settlements, and changed passcodes or AI connections, and when. The log is append-only, hash-chained and signed.',
  input: z.object({
    limit: z.number().int().min(1).max(100).default(30).describe('Maximum number of entries to return'),
    before: z.number().int().positive().optional().describe('Only entries with a sequence number below this value, for paging back'),
  }),
  write: false,
  async read(args, ctx) {
    const page = await ctx.auditLog({ before: args.before, limit: args.limit });
    return {
      total: page.head?.seq ?? 0,
      signed: page.publicKey !== null,
      entries: page.records.map((r) => {
        const { seq, at, actor, action, via } = parseAudit(r);
        const { summary, details } = describeAudit(action, TOOL_LOCALE);
        return { seq, at: new Date(at).toISOString(), actor: actorLabel(actor, TOOL_LOCALE, via), summary, details };
      }),
    };
  },
});

const addExpense = writeTool({
  name: 'add_expense',
  title: 'Add expense',
  description: `Record an expense paid by one member. Use member names for payer, participants and shares. Omit date for today. ${SPLIT_HELP} Omit category to guess it from the title.`,
  input: z.object({
    title: z.string().describe(`What it was for, at most ${LIMITS.title} characters, e.g. "Lunch" or "Taxi"; use the user's language`),
    amount: money.describe('Amount in CNY with at most two decimals, e.g. 128.5'),
    payer: memberRef.describe('Who paid, by name or ID'),
    participants: z.array(memberRef).min(1).max(LIMITS.members).optional().describe('Members splitting the cost evenly (names or IDs); omit for all members'),
    shares: z.array(shareArg).min(1).max(LIMITS.members).optional().describe('Custom split instead of participants'),
    category: categoryArg.optional().describe(`${CATEGORY_HELP}; omit to guess from the title`),
    date: date.optional().describe('Date YYYY-MM-DD; omit for today'),
  }),
  write: true,
  plan(args, { data, today }) {
    const amount = toCents(args.amount);
    const expense = validate(expenseInput, {
      title: args.title,
      amount,
      payerId: resolveMember(data.members, args.payer).id,
      date: args.date ?? today,
      category: args.category ?? guessCategory(args.title),
      split: planSplit(data.members, amount, args.participants, args.shares) ?? { mode: 'even', memberIds: data.members.map((m) => m.id) },
    });
    return { op: 'expense.create', id: newId(), expense };
  },
  describe(change, _, after) {
    const created = find(after.expenses, change.id);
    return { created: created ? viewer(after).expense(created) : null };
  },
});

const updateExpense = writeTool({
  name: 'update_expense',
  title: 'Update expense',
  description:
    'Update an expense; only pass the fields to change. participants or shares replace the whole split; without them the split is kept (an even split is recomputed for a new amount, a custom split needs new shares with a new amount). Get the id from list_transactions.',
  input: z.object({
    id: recordId.describe('Expense ID'),
    title: z.string().optional().describe('New description'),
    amount: money.optional().describe('New amount (CNY)'),
    payer: memberRef.optional().describe('New payer'),
    participants: z.array(memberRef).min(1).max(LIMITS.members).optional().describe('New list of members splitting the cost evenly'),
    shares: z.array(shareArg).min(1).max(LIMITS.members).optional().describe('New custom split instead of participants'),
    category: categoryArg.optional().describe(CATEGORY_HELP),
    date: date.optional().describe('New date'),
  }),
  write: true,
  idempotent: true,
  plan(args, { data }) {
    const current = find(data.expenses, args.id);
    if (!current) throw fail('expenseNotFound');
    const amount = args.amount === undefined ? current.amount : toCents(args.amount);
    let split = planSplit(data.members, amount, args.participants, args.shares);
    if (!split) {
      split = splitOf(current, data.members);
      if (split.mode === 'exact' && amount !== current.amount) {
        throw new ToolError('This expense has a custom split; pass shares (or participants for an even split) together with the new amount');
      }
    }
    const expense = validate(expenseInput, {
      title: args.title ?? current.title,
      amount,
      payerId: args.payer ? resolveMember(data.members, args.payer).id : current.payerId,
      date: args.date ?? current.date,
      category: args.category ?? current.category,
      split,
    });
    return { op: 'expense.update', id: current.id, expense, ifUpdatedAt: current.updatedAt };
  },
  describe(change, before, after) {
    const old = find(before.expenses, change.id);
    const now = find(after.expenses, change.id);
    return { before: old ? viewer(before).expense(old) : null, after: now ? viewer(after).expense(now) : null };
  },
});

const deleteExpense = writeTool({
  name: 'delete_expense',
  title: 'Delete expense',
  description: 'Delete an expense (cannot be undone). Get the id from list_transactions.',
  input: z.object({ id: recordId.describe('Expense ID') }),
  write: true,
  destructive: true,
  idempotent: true,
  plan(args, { data }) {
    const current = find(data.expenses, args.id);
    if (!current) throw fail('expenseNotFound');
    return { op: 'expense.delete', id: current.id, ifUpdatedAt: current.updatedAt };
  },
  describe(change, before) {
    const old = find(before.expenses, change.id);
    return { deleted: old ? viewer(before).expense(old) : null };
  },
});

const addMember = writeTool({
  name: 'add_member',
  title: 'Add member',
  description: `Add a member to the ledger. Names are at most ${LIMITS.memberName} characters and must be unique.`,
  input: z.object({
    name: z.string().describe('Member name'),
    avatar: z.string().max(LIMITS.avatar).optional().describe('Avatar emoji; random if omitted'),
  }),
  write: true,
  plan(args) {
    const input = validate(memberInput, args);
    const avatar = input.avatar || AVATARS[Math.floor(Math.random() * AVATARS.length)]!;
    return { op: 'member.create', id: newId(), member: { name: input.name, avatar } };
  },
  describe(change, _, after) {
    const member = find(after.members, change.id);
    return { created: member ? viewer(after).member(member) : null };
  },
});

const updateMember = writeTool({
  name: 'update_member',
  title: 'Update member',
  description: "Change a member's name or avatar.",
  input: z.object({
    member: memberRef.describe('Member to update, by name or ID'),
    name: z.string().optional().describe('New name'),
    avatar: z.string().max(LIMITS.avatar).optional().describe('New avatar emoji'),
  }),
  write: true,
  idempotent: true,
  plan(args, { data }) {
    const current = resolveMember(data.members, args.member);
    const member = validate(memberInput, { name: args.name ?? current.name, avatar: args.avatar ?? current.avatar });
    return { op: 'member.update', id: current.id, member };
  },
  describe(change, _, after) {
    const member = find(after.members, change.id);
    return { updated: member ? viewer(after).member(member) : null };
  },
});

const recordSettlement = writeTool({
  name: 'record_settlement',
  title: 'Record settlement',
  description:
    "Record a settlement: from has paid money to to. Typically used to settle up following get_ledger's suggestedTransfers. Omit date for today.",
  input: z.object({
    from: memberRef.describe('Who paid the money back'),
    to: memberRef.describe('Who received it'),
    amount: money.describe('Amount (CNY)'),
    date: date.optional().describe('Date YYYY-MM-DD; omit for today'),
    note: z.string().max(LIMITS.note).optional().describe('Note, e.g. "WeChat transfer"'),
  }),
  write: true,
  plan(args, { data, today }) {
    const settlement = validate(settlementInput, {
      fromId: resolveMember(data.members, args.from).id,
      toId: resolveMember(data.members, args.to).id,
      amount: toCents(args.amount),
      date: args.date ?? today,
      note: args.note ?? null,
    });
    return { op: 'settlement.create', id: newId(), settlement };
  },
  describe(change, _, after) {
    const created = find(after.settlements, change.id);
    return { created: created ? viewer(after).settlement(created) : null };
  },
});

const deleteSettlement = writeTool({
  name: 'delete_settlement',
  title: 'Delete settlement',
  description: 'Delete a settlement record (undo a "paid"). Get the id from list_transactions.',
  input: z.object({ id: recordId.describe('Settlement ID') }),
  write: true,
  destructive: true,
  idempotent: true,
  plan(args, { data }) {
    const current = find(data.settlements, args.id);
    if (!current) throw fail('settlementNotFound');
    return { op: 'settlement.delete', id: current.id };
  },
  describe(change, before) {
    const old = find(before.settlements, change.id);
    return { deleted: old ? viewer(before).settlement(old) : null };
  },
});

export const LEDGER_TOOLS: LedgerTool[] = [
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

export const findLedgerTool = (name: string) => LEDGER_TOOLS.find((t) => t.name === name);
