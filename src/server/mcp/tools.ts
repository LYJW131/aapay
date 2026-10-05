import { z } from 'zod';
import { byNewest } from '../../shared/ledger.ts';
import { MAX_AMOUNT, type Cents } from '../../shared/money.ts';
import { actorLabel, describeAudit } from '../../shared/audit-text.ts';
import { parseAudit, type AuditActor } from '../../shared/audit.ts';
import { isPlainErrorKey, translateError } from '../../shared/errors.ts';
import type { Locale } from '../../shared/i18n.ts';
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
  .positive('amount must be greater than 0')
  .max(MAX_AMOUNT / 100, 'amount is too large')
  .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, 'amount can have at most two decimal places');
const toCents = (v: number) => Math.round(v * 100);

const memberRef = z.string().trim().min(1).max(64);
const date = isoDate.describe('Date, YYYY-MM-DD');
const recordId = z.string().trim().min(1).max(64);

const LOCALE: Locale = 'en';

class ToolError extends Error {}

const issueText = (message: string | undefined) =>
  message === undefined ? translateError(LOCALE, 'invalidParams') : isPlainErrorKey(message) ? translateError(LOCALE, message) : message;

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
  const names = members.map((m) => m.name).join(', ');
  throw new ToolError(`No member named "${ref}". ${names ? `Members: ${names}` : 'The ledger has no members yet; add one with add_member first'}`);
}

function viewer(data: LedgerData) {
  const byId = new Map(data.members.map((m) => [m.id, m]));
  const name = (id: string) => byId.get(id)?.name ?? '(deleted member)';
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
  title: 'Get ledger overview',
  description:
    'Show the ledger: members, total spent, what each member paid / owes / nets, and the minimal set of transfers to settle up. ' +
    'net > 0 means others owe this member; net < 0 means this member owes others. Amounts are in CNY. Call this before recording expenses to learn member names.',
  input: z.object({}),
  write: false,
  async run(_, ctx) {
    const data = await ctx.ledger.snapshot();
    const v = viewer(data);
    const name = (id: string) => data.members.find((m) => m.id === id)?.name ?? '(deleted member)';
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
  title: 'List transactions',
  description: 'List expenses and settlements, newest first, optionally filtered by date range, member, type and keyword. The returned ids can be used to update or delete records.',
  input: z.object({
    from: date.optional().describe('Start date (inclusive), YYYY-MM-DD'),
    to: date.optional().describe('End date (inclusive), YYYY-MM-DD'),
    member: memberRef.optional().describe('Only records involving this member (paid, shared, or settled), by name or ID'),
    type: z.enum(['all', 'expense', 'settlement']).default('all').describe('Record type'),
    query: z.string().trim().max(40).optional().describe('Keyword to match in the expense description or settlement note'),
    limit: z.number().int().min(1).max(200).default(50).describe('Maximum number of records to return'),
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
  title: 'List activity',
  description: 'Show the ledger audit log, newest first: who added, edited or deleted expenses, recorded settlements, and changed passcodes or AI connections, and when. The log is append-only, hash-chained and signed.',
  input: z.object({
    limit: z.number().int().min(1).max(100).default(30).describe('Maximum number of entries to return'),
    before: z.number().int().positive().optional().describe('Only entries with a sequence number below this value, for paging back'),
  }),
  write: false,
  async run(args, ctx) {
    const page = await ctx.ledger.auditLog({ before: args.before, limit: args.limit });
    return {
      total: page.head?.seq ?? 0,
      signed: page.publicKey !== null,
      entries: page.records.map((r) => {
        const { seq, at, actor, action } = parseAudit(r);
        const { summary, details } = describeAudit(action, LOCALE);
        return { seq, at: new Date(at).toISOString(), actor: actorLabel(actor, LOCALE), summary, details };
      }),
    };
  },
});

const addExpense = tool({
  name: 'add_expense',
  title: 'Add expense',
  description:
    'Record an expense paid by one member and split evenly among participants (leftover cents go to members in join order). Use member names for payer and participants. ' +
    'Omit participants to split among all members; omit date for today.',
  input: z.object({
    title: z.string().describe(`What it was for, at most ${LIMITS.title} characters, e.g. "Lunch" or "Taxi"; use the user's language`),
    amount: money.describe('Amount in CNY with at most two decimals, e.g. 128.5'),
    payer: memberRef.describe('Who paid, by name or ID'),
    participants: z.array(memberRef).min(1).max(LIMITS.members).optional().describe('Members sharing the cost (names or IDs); omit for all members'),
    date: date.optional().describe('Date YYYY-MM-DD; omit for today'),
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
  title: 'Update expense',
  description: 'Update an expense; only pass the fields to change. participants replaces the whole split list. Get the id from list_transactions.',
  input: z.object({
    id: recordId.describe('Expense ID'),
    title: z.string().optional().describe('New description'),
    amount: money.optional().describe('New amount (CNY)'),
    payer: memberRef.optional().describe('New payer'),
    participants: z.array(memberRef).min(1).max(LIMITS.members).optional().describe('New list of members sharing the cost'),
    date: date.optional().describe('New date'),
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
  title: 'Delete expense',
  description: 'Delete an expense (cannot be undone). Get the id from list_transactions.',
  input: z.object({ id: recordId.describe('Expense ID') }),
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
  title: 'Add member',
  description: `Add a member to the ledger. Names are at most ${LIMITS.memberName} characters and must be unique.`,
  input: z.object({
    name: z.string().describe('Member name'),
    avatar: z.string().max(LIMITS.avatar).optional().describe('Avatar emoji; random if omitted'),
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
  title: 'Update member',
  description: "Change a member's name or avatar.",
  input: z.object({
    member: memberRef.describe('Member to update, by name or ID'),
    name: z.string().optional().describe('New name'),
    avatar: z.string().max(LIMITS.avatar).optional().describe('New avatar emoji'),
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
  title: 'Delete settlement',
  description: 'Delete a settlement record (undo a "paid"). Get the id from list_transactions.',
  input: z.object({ id: recordId.describe('Settlement ID') }),
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

const ledgerRef = z.string().trim().min(1).max(64).describe('Ledger name or ID (see list_ledgers)');
const ledgerOption = ledgerRef
  .optional()
  .describe('Ledger name or ID. Required for admin grants (see list_ledgers); member grants can only access the ledger chosen during authorization and may omit it');

async function resolveLedger(platform: Platform, ref: string | undefined): Promise<LedgerInfo> {
  const ledgers = await platform.registry.listLedgers();
  const key = ref?.trim();
  const found = key && (ledgers.find((l) => l.id === key) ?? ledgers.find((l) => l.name.toLowerCase() === key.toLowerCase()));
  if (found) return { id: found.id, name: found.name, emoji: found.emoji };
  const names = ledgers.map((l) => `"${l.name}"`).join(', ');
  const hint = names ? `Ledgers: ${names}` : 'There are no ledgers yet; create one with create_ledger';
  throw new ToolError(key ? `No ledger named "${ref}". ${hint}` : `Admin grants must specify the ledger argument. ${hint}`);
}

async function targetLedger(session: McpSession, ref: string | undefined): Promise<LedgerInfo> {
  if (session.role === 'admin') return resolveLedger(session.platform, ref);
  const bound = session.ledger!;
  if (ref !== undefined && ref !== bound.id && ref.toLowerCase() !== bound.name.toLowerCase()) {
    throw new ToolError(`This connection is only authorized for ledger "${bound.name}" and cannot access "${ref}"`);
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

const validDays = z.number().int().min(1).max(3650).optional().describe('Number of days the passcode stays valid; omit for no expiry');

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
  title: 'List ledgers',
  description: 'List all ledgers with their member count, expense count, total spent (CNY), active passcodes and connected AI apps.',
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
  title: 'Create ledger',
  description: 'Create a new ledger. By default also creates a share passcode and returns an invite link that friends can open to join.',
  input: z.object({
    name: z.string().describe(`Ledger name, at most ${LIMITS.ledgerName} characters, unique among ledgers`),
    emoji: z.string().optional().describe('Ledger icon (one emoji); random if omitted'),
    create_passphrase: z.boolean().default(true).describe('Whether to also create a share passcode'),
    passphrase: z.string().optional().describe(`Custom passcode (${LIMITS.codeMin}-${LIMITS.codeMax} letters or digits); random if omitted`),
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
  title: 'Update ledger',
  description: "Change a ledger's name or icon; members viewing it see the change immediately.",
  input: z.object({
    ledger: ledgerRef,
    name: z.string().optional().describe('New name; unchanged if omitted'),
    emoji: z.string().optional().describe('New icon (one emoji); unchanged if omitted'),
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
  title: 'Delete ledger',
  description: 'Permanently delete a ledger with all its records, passcodes and AI connections; this cannot be undone. To prevent accidents, confirm_name must exactly match the ledger name.',
  input: z.object({ ledger: ledgerRef, confirm_name: z.string().describe('The name of the ledger to delete, typed again to confirm') }),
  write: true,
  destructive: true,
  async run(args, ctx) {
    const target = await resolveLedger(ctx.session.platform, args.ledger);
    if (args.confirm_name.trim() !== target.name) {
      throw new ToolError(`confirm_name does not match: the ledger to delete is named "${target.name}". Confirm with the user, then set confirm_name to that name`);
    }
    return { deleted: await ctx.actions.deleteLedger(target.id) };
  },
});

const listPassphrases = adminTool({
  name: 'list_passphrases',
  title: 'List passcodes',
  description: "List a ledger's share passcodes with their status (active / pending / expired) and invite links.",
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
  title: 'Create passcode',
  description: 'Create a share passcode for a ledger and return it with an invite link (opening the link joins the ledger).',
  input: z.object({
    ledger: ledgerRef,
    code: z.string().optional().describe(`Custom passcode (${LIMITS.codeMin}-${LIMITS.codeMax} letters or digits); random if omitted`),
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
  title: 'Revoke passcode',
  description: 'Revoke a share passcode: member sessions and AI connections that joined with it stop working immediately.',
  input: z.object({ ledger: ledgerRef, code: z.string().trim().min(1).describe('Passcode to revoke') }),
  write: true,
  destructive: true,
  idempotent: true,
  async run(args, ctx) {
    const target = await resolveLedger(ctx.session.platform, args.ledger);
    const list = await ctx.session.platform.registry.listPassphrases(target.id);
    const found = list.find((p) => p.code.toLowerCase() === args.code.toLowerCase());
    if (!found) throw new ToolError(`Ledger "${target.name}" has no passcode "${args.code}"`);
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
  description: kind === 'admin' ? `${tool.description} Admin grants only.` : tool.description,
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
  if (!entry) throw new UnknownToolError(`Unknown tool ${name}`);
  if (!permitted(entry, session)) {
    return fail(
      `${name} is an admin tool, and this connection is only authorized for ledger "${session.ledger!.name}". ` +
        'To manage all ledgers, reconnect AAPay in the AI app and authorize as an admin on the consent page (choose "All ledgers").',
    );
  }

  const parsed = entry.input.safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(`Invalid arguments: ${issue?.path.join('.') || 'input'} ${issue ? issueText(issue.message) : ''}`.trim());
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
    if (err instanceof AppError) return fail(err.localized(LOCALE));
    if (err instanceof ToolError) return fail(err.message);
    throw err;
  }
}
