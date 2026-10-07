import type { SSEStreamingApi } from 'hono/streaming';
import { z } from 'zod';
import type { AssistantEvent, AssistantRequest, AssistantView, DraftFields, DroppedChange } from '../../shared/assistant.ts';
import { CATEGORIES, isCategory } from '../../shared/categories.ts';
import type { Change } from '../../shared/changes.ts';
import { translateError } from '../../shared/errors.ts';
import type { Locale } from '../../shared/i18n.ts';
import { isoDate, LIMITS } from '../../shared/schema.ts';
import type { LedgerData, LedgerInfo, Member } from '../../shared/types.ts';
import { AppError, type ErrorStatus } from '../core/errors.ts';
import type { LedgerService } from '../core/ledger.ts';
import type { Remote } from '../core/remote.ts';
import {
  findLedgerTool,
  inputSchema,
  LEDGER_TOOLS,
  memberRef,
  money,
  parseArgs,
  resolveMember,
  TOOL_LOCALE,
  ToolError,
  type WriteTool,
} from '../tools/ledger.ts';
import { GeminiError, streamGemini, type FunctionDeclaration, type GeminiKey, type GeminiContent, type GeminiFunctionCall, type GeminiPart } from './gemini.ts';
import { ItemStream, type ItemEvent } from './item-stream.ts';
import { fold } from './pending.ts';
import { changeLine, EXTRACTION_SCHEMA, extractionPrompt, imagesNote, MAX_EXTRACTED, SHOW_DESCRIPTION, systemPrompt } from './prompts.ts';

export const MAX_ROUNDS = 6;
const EXTRACT_STEP = 'read_images';

export interface AssistantDeps {
  gemini: GeminiKey;
  byok: boolean;
  api: Remote<LedgerService>;
  info: LedgerInfo;
  locale: Locale;
}

interface Run extends AssistantDeps {
  signal: AbortSignal;
  emit(event: AssistantEvent): Promise<void>;
}

class Aborted extends Error {}

const showInput = z.object({
  view: z.enum(['balances', 'settle', 'categories', 'trend', 'transactions']).describe('Which card to show'),
  from: isoDate.optional().describe('Start date (inclusive), YYYY-MM-DD'),
  to: isoDate.optional().describe('End date (inclusive), YYYY-MM-DD'),
  member: memberRef.optional().describe('Only this member, by name or ID'),
  category: z.enum(CATEGORIES).optional().describe('Only this category (trend and transactions)'),
  query: z.string().trim().max(40).optional().describe('Keyword in the description or note (transactions)'),
});

const DECLARATIONS: FunctionDeclaration[] = [
  ...LEDGER_TOOLS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: inputSchema(t.input) })),
  { name: 'show', description: SHOW_DESCRIPTION, parametersJsonSchema: inputSchema(showInput) },
];

const extractedItem = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .transform((s) => s.slice(0, LIMITS.title)),
  amount: z
    .number()
    .transform((v) => Math.round(Math.abs(v) * 100) / 100)
    .pipe(money),
  date: isoDate.nullable().catch(null),
  category: z.enum(CATEGORIES).nullable().catch(null),
});

const addExpense = findLedgerTool('add_expense') as WriteTool;

function resolveView(args: z.infer<typeof showInput>, data: LedgerData): AssistantView {
  const memberId = args.member ? resolveMember(data.members, args.member).id : null;
  const range = { from: args.from ?? null, to: args.to ?? null };
  switch (args.view) {
    case 'balances':
      return { kind: 'balances' };
    case 'settle':
      return { kind: 'settle' };
    case 'categories':
      return { kind: 'categories', memberId, ...range };
    case 'trend':
      return { kind: 'trend', memberId, category: args.category ?? null, ...range };
    case 'transactions':
      return { kind: 'transactions', memberId, category: args.category ?? null, query: args.query || null, ...range };
  }
}

function draftFields(value: Record<string, unknown> | null): DraftFields {
  const fields: DraftFields = {};
  if (!value) return fields;
  if (typeof value.title === 'string' && value.title.trim()) fields.title = value.title.trim().slice(0, LIMITS.title);
  if (typeof value.amount === 'number' && value.amount > 0) fields.amount = value.amount;
  if (value.date === null) fields.date = null;
  else if (typeof value.date === 'string' && isoDate.safeParse(value.date).success) fields.date = value.date;
  if (isCategory(value.category)) fields.category = value.category;
  return fields;
}

const reasonOf = (err: unknown, locale: Locale) => {
  if (err instanceof AppError) return err.localized(locale);
  throw err;
};

const modelError = (err: unknown) => {
  if (err instanceof ToolError) return err.message;
  if (err instanceof AppError) return err.localized(TOOL_LOCALE);
  throw err;
};

class Draft {
  private readonly api: Remote<LedgerService>;
  readonly real: LedgerData;
  pending: Change[];
  data: LedgerData;

  private constructor(api: Remote<LedgerService>, real: LedgerData, pending: Change[], data: LedgerData) {
    this.api = api;
    this.real = real;
    this.pending = pending;
    this.data = data;
  }

  static async open(api: Remote<LedgerService>, pending: Change[], locale: Locale) {
    const real = await api.snapshot();
    const dropped: DroppedChange[] = [];
    if (!pending.length) return { draft: new Draft(api, real, [], real), dropped };
    try {
      return { draft: new Draft(api, real, pending, await api.previewChanges(pending)), dropped };
    } catch (err) {
      reasonOf(err, locale);
    }
    let accepted: Change[] = [];
    let data = real;
    for (const change of pending) {
      try {
        data = await api.previewChanges([...accepted, change]);
        accepted = [...accepted, change];
      } catch (err) {
        dropped.push({ id: change.id, reason: reasonOf(err, locale) });
      }
    }
    return { draft: new Draft(api, real, accepted, data), dropped };
  }

  async propose(change: Change) {
    const pending = fold(this.pending, change, this.real);
    this.data = pending.length ? await this.api.previewChanges(pending) : this.real;
    this.pending = pending;
  }
}

function history(request: AssistantRequest, extra: GeminiPart[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  request.messages.forEach((turn, i) => {
    const last = i === request.messages.length - 1;
    const parts: GeminiPart[] = turn.text.trim() ? [{ text: turn.text }] : [];
    if (last) parts.push(...extra);
    if (last && !parts.length) parts.push({ text: '…' });
    if (!parts.length) return;
    const role = turn.role === 'user' ? 'user' : 'model';
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  });
  return contents;
}

function inlineImage(dataUrl: string): GeminiPart {
  const [, mimeType, data] = dataUrl.match(/^data:(image\/\w+);base64,(.*)$/)!;
  return { inlineData: { mimeType: mimeType!, data: data! } };
}

async function extract(run: Run, request: AssistantRequest, draft: Draft, me: Member, participants: Member[] | null) {
  await run.emit({ type: 'step', id: EXTRACT_STEP, tool: EXTRACT_STEP, status: 'start' });
  const parser = new ItemStream(3);
  const drafted = new Set<string>();
  let accepted = 0;

  const settle = async (event: ItemEvent) => {
    const key = `d${event.index}`;
    if (event.index >= MAX_EXTRACTED) return;
    if (!event.done) {
      const fields = draftFields(event.value);
      if (!Object.keys(fields).length) return;
      drafted.add(key);
      await run.emit({ type: 'draft', key, fields });
      return;
    }
    const item = extractedItem.safeParse(event.value);
    if (item.success) {
      try {
        const { title, amount, date, category } = item.data;
        const change = addExpense.plan(
          { title, amount, payer: me.id, participants: participants?.map((m) => m.id), category: category ?? undefined, date: date ?? undefined },
          { data: draft.data, today: request.today },
        );
        await draft.propose(change);
        if (!drafted.has(key)) await run.emit({ type: 'draft', key, fields: draftFields(event.value) });
        await run.emit({ type: 'pending', changes: draft.pending, replaces: key });
        accepted++;
        return;
      } catch (err) {
        console.warn('assistant dropped extracted item', modelError(err));
      }
    }
    if (drafted.has(key)) await run.emit({ type: 'discard', key });
  };

  try {
    const stream = streamGemini(
      {
        systemInstruction: { parts: [{ text: extractionPrompt(request.today, run.locale) }] },
        contents: [{ role: 'user', parts: [...request.images.map(inlineImage), { text: 'Extract the expenses in these images.' }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: EXTRACTION_SCHEMA, temperature: 0 },
      },
      { ...run.gemini, signal: run.signal },
    );
    for await (const parts of stream) {
      const text = parts
        .filter((p) => !p.thought)
        .map((p) => p.text ?? '')
        .join('');
      for (const event of parser.feed(text)) await settle(event);
    }
  } catch (err) {
    if (!run.signal.aborted) await run.emit({ type: 'step', id: EXTRACT_STEP, tool: EXTRACT_STEP, status: 'error' });
    throw err;
  }
  await run.emit({ type: 'step', id: EXTRACT_STEP, tool: EXTRACT_STEP, status: 'done' });
  return accepted;
}

async function execute(run: Run, request: AssistantRequest, draft: Draft, call: GeminiFunctionCall): Promise<object> {
  const args = call.args ?? {};
  if (call.name === 'show') {
    const view = resolveView(parseArgs(showInput, args), draft.data);
    await run.emit({ type: 'view', view });
    return { status: 'shown', note: 'The user now sees this card with live numbers; do not repeat them or say where the card is.' };
  }
  const tool = findLedgerTool(call.name);
  if (!tool) throw new ToolError(`Unknown tool ${call.name}`);
  const parsed = parseArgs(tool.input, args);
  if (!tool.write) {
    const result = await tool.read(parsed, { data: draft.real, info: run.info, today: request.today, auditLog: (q) => run.api.auditLog(q) });
    if (!draft.pending.length) return result;
    return {
      ...result,
      pendingChanges: draft.pending.map((c) => ({ op: c.op, id: c.id, summary: changeLine(c, draft.real, draft.data) })),
      note: 'The results above only cover the confirmed ledger. pendingChanges are proposals the user has not confirmed yet; they are not in the ledger.',
    };
  }
  const before = draft.data;
  const change = tool.plan(parsed, { data: before, today: request.today });
  await draft.propose(change);
  await run.emit({ type: 'pending', changes: draft.pending });
  return {
    status: 'proposed',
    note: 'Not saved yet: the user must confirm this change in the app.',
    id: change.id,
    ...tool.describe(change, before, draft.data),
  };
}

async function converse(run: Run, request: AssistantRequest, draft: Draft, me: Member | null, participants: Member[] | null, extra: GeminiPart[]) {
  const contents = history(request, extra);
  const system = systemPrompt({
    info: run.info,
    real: draft.real,
    draft: draft.data,
    pending: draft.pending,
    me,
    participants,
    today: request.today,
    locale: run.locale,
  });
  let calls = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const modelParts: GeminiPart[] = [];
    const responses: GeminiPart[] = [];
    const stream = streamGemini(
      {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: DECLARATIONS }],
        ...(round === MAX_ROUNDS - 1 && { toolConfig: { functionCallingConfig: { mode: 'NONE' as const } } }),
      },
      { ...run.gemini, signal: run.signal },
    );
    for await (const parts of stream) {
      for (const part of parts) {
        modelParts.push(part);
        if (part.functionCall) {
          const call = part.functionCall;
          const id = call.id ?? `call_${++calls}`;
          await run.emit({ type: 'step', id, tool: call.name, status: 'start' });
          let response: object;
          try {
            response = await execute(run, request, draft, call);
            await run.emit({ type: 'step', id, tool: call.name, status: 'done' });
          } catch (err) {
            response = { error: modelError(err) };
            await run.emit({ type: 'step', id, tool: call.name, status: 'error' });
          }
          responses.push({ functionResponse: { ...(call.id && { id: call.id }), name: call.name, response } });
        } else if (part.text && !part.thought) {
          await run.emit({ type: 'text', delta: part.text });
        }
      }
    }
    if (!responses.length) return;
    contents.push({ role: 'model', parts: modelParts }, { role: 'user', parts: responses });
  }
}

export async function runAssistant(run: Run, request: AssistantRequest) {
  const { draft, dropped } = await Draft.open(run.api, request.pending, run.locale);
  await run.emit({ type: 'pending', changes: draft.pending, ...(dropped.length && { dropped }) });

  const byId = new Map(draft.data.members.map((m) => [m.id, m]));
  const me = (request.me && byId.get(request.me)) || null;
  const chosen = request.participants?.flatMap((id) => byId.get(id) ?? []) ?? [];
  const participants = chosen.length ? chosen : null;

  let extra: GeminiPart[] = request.images.map(inlineImage);
  if (request.images.length && me) {
    const extracted = await extract(run, request, draft, me, participants);
    extra = [{ text: imagesNote(request.images.length, extracted) }];
  }
  await converse(run, request, draft, me, participants, extra);
  await run.emit({ type: 'done' });
}

export const UPSTREAM_STATUS = {
  assistantKeyInvalid: 400,
  assistantModelNotFound: 400,
  assistantKeyQuota: 429,
  assistantRateLimited: 429,
  assistantTimeout: 504,
  assistantUnavailable: 502,
} as const satisfies Record<string, ErrorStatus>;

export function upstreamError({ status, message }: GeminiError, byok: boolean): keyof typeof UPSTREAM_STATUS {
  if (byok) {
    if (status === 401 || status === 403 || (status === 400 && /API.?key/i.test(message))) return 'assistantKeyInvalid';
    if (status === 404) return 'assistantModelNotFound';
    if (status === 429) return 'assistantKeyQuota';
  }
  return status === 429 ? 'assistantRateLimited' : status === 504 ? 'assistantTimeout' : 'assistantUnavailable';
}

function failure(err: unknown, { locale, byok }: AssistantDeps) {
  if (err instanceof GeminiError) {
    console.error('assistant upstream failed', err.status, err.message);
    return translateError(locale, upstreamError(err, byok));
  }
  console.error('assistant failed', err);
  return translateError(locale, 'assistantFailed');
}

export async function streamAssistant(stream: SSEStreamingApi, request: AssistantRequest, deps: AssistantDeps) {
  const controller = new AbortController();
  stream.onAbort(() => controller.abort());
  const emit = async (event: AssistantEvent) => {
    if (stream.aborted || controller.signal.aborted) throw new Aborted();
    await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
  };
  try {
    await runAssistant({ ...deps, signal: controller.signal, emit }, request);
  } catch (err) {
    if (!(err instanceof Aborted) && !controller.signal.aborted && !stream.aborted) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: failure(err, deps) } satisfies AssistantEvent) });
    }
  } finally {
    controller.abort();
  }
}
