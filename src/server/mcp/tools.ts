import { z } from 'zod';
import type { AuditActor } from '../../shared/audit.ts';
import { applyEvent } from '../../shared/ledger.ts';
import { randomPassphrase } from '../../shared/passphrase.ts';
import { ledgerInput, LIMITS, passphraseInput } from '../../shared/schema.ts';
import type { LedgerInfo, McpScope, Passphrase } from '../../shared/types.ts';
import { adminActions } from '../admin.ts';
import { AppError } from '../core/errors.ts';
import type { GrantRole } from '../core/registry.ts';
import type { Platform } from '../platform.ts';
import { issueText, LEDGER_TOOLS, TOOL_LOCALE, ToolError, validate, yuan, type LedgerTool } from '../tools/ledger.ts';

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

interface AdminTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  write: boolean;
  destructive?: boolean;
  idempotent?: boolean;
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

type AnyTool = { kind: 'ledger'; tool: LedgerTool; input: z.ZodObject } | { kind: 'admin'; tool: AdminTool; input: z.ZodObject };

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

async function runLedgerTool(tool: LedgerTool, args: Record<string, unknown>, session: McpSession): Promise<object> {
  const info = await targetLedger(session, args.ledger as string | undefined);
  const api = session.platform.ledger(info.id).api;
  const data = await api.snapshot();
  if (!tool.write) {
    return tool.read(args, { data, info, today: session.today, permissions: [...session.scopes], auditLog: (query) => api.auditLog(query) });
  }
  const change = tool.plan(args, { data, today: session.today });
  const { messages } = await api.applyChanges([change], { actor: session.actor, origin: session.origin });
  const after = messages.reduce((acc, m) => applyEvent(acc, m.event, m.v), data);
  return tool.describe(change, data, after);
}

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
      result = await runLedgerTool(entry.tool, parsed.data, session);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (err) {
    if (err instanceof AppError) return fail(err.localized(TOOL_LOCALE));
    if (err instanceof ToolError) return fail(err.message);
    throw err;
  }
}
