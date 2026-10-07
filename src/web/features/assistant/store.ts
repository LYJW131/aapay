import { toast } from 'sonner';
import type { AssistantEvent, AssistantRequest, AssistantTurn, AssistantView, DraftFields, DroppedChange } from '../../../shared/assistant.ts';
import type { Change } from '../../../shared/changes.ts';
import type { ExpenseInput } from '../../../shared/schema.ts';
import type { Member } from '../../../shared/types.ts';
import { newId } from '../../../shared/ids.ts';
import { LIMITS } from '../../../shared/limits.ts';
import { assistant as t } from '../../i18n/assistant.ts';
import { common } from '../../i18n/common.ts';
import { ApiError, errorMessage } from '../../lib/api.ts';
import { today } from '../../lib/dates.ts';
import { streamSse } from '../../lib/sse.ts';
import { load, save } from '../../lib/storage.ts';
import { highlight } from '../ledger/highlight.ts';
import type { LedgerStore } from '../ledger/store.ts';
import { ownKeyHeaders } from './own-key.ts';

export type Part = { kind: 'text'; text: string } | { kind: 'view'; view: AssistantView };

export interface Step {
  id: string;
  tool: string;
  status: 'start' | 'done' | 'error';
}

export interface Draft {
  key: string;
  fields: DraftFields;
}

export type ChangeStatus = 'pending' | 'applying' | 'applied' | 'undoing' | 'undone' | 'redoing' | 'discarded' | 'superseded' | 'conflict';

export interface ChangeSet {
  changes: Change[];
  status: ChangeStatus;
  dropped: DroppedChange[];
  morph: Record<string, string>;
  fresh: string[];
  carried?: boolean;
  applied?: number;
  undo?: Change[];
  redo?: Change[];
  error?: string;
}

export interface UserMessage {
  id: string;
  role: 'user';
  text: string;
  images?: string[];
  imageCount: number;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  parts: Part[];
  steps: Step[];
  drafts: Draft[];
  changeSet: ChangeSet | null;
  state: 'streaming' | 'done' | 'error' | 'stopped';
  error?: string;
  needsMe?: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface AssistantState {
  messages: ChatMessage[];
  streaming: boolean;
  autoRun: boolean;
}

export const changeKey = (change: Change) => `${change.op}:${change.id}`;

const MAX_MESSAGES = 50;
const LIVE: ChangeStatus[] = ['pending', 'applying', 'conflict'];
const OPEN: ChangeStatus[] = ['pending', 'conflict'];

const closeSteps = (steps: Step[]) => steps.map((s) => (s.status === 'start' ? { ...s, status: 'error' as const } : s));
const lostImages = (user: UserMessage) => user.imageCount > 0 && !user.images?.length;

function splitMembers(split: ExpenseInput['split']) {
  return split.mode === 'even' ? split.memberIds : split.shares.map((s) => s.memberId);
}

function referencesMissing(changes: readonly Change[], members: readonly Member[]) {
  const known = new Set([...members.map((m) => m.id), ...changes.flatMap((c) => (c.op === 'member.create' ? [c.id] : []))]);
  return changes.some((c) => {
    if (c.op === 'expense.create' || c.op === 'expense.update') return [c.expense.payerId, ...splitMembers(c.expense.split)].some((id) => !known.has(id));
    if (c.op === 'settlement.create') return !known.has(c.settlement.fromId) || !known.has(c.settlement.toId);
    return false;
  });
}

export function findPending(messages: readonly ChatMessage[]): { message: AssistantMessage; set: ChangeSet } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.changeSet && m.changeSet.changes.length > 0 && LIVE.includes(m.changeSet.status)) {
      return { message: m, set: m.changeSet };
    }
  }
  return null;
}

function historyNote(set: ChangeSet | null) {
  if (!set || set.changes.length === 0) return '';
  switch (set.status) {
    case 'applied':
      return `[${set.applied ?? set.changes.length} changes applied]`;
    case 'undone':
      return '[changes applied, then undone by the user]';
    case 'discarded':
      return '[changes discarded by the user]';
    case 'conflict':
      return '[applying failed: the ledger changed]';
    default:
      return '';
  }
}

function textOf(message: AssistantMessage) {
  return message.parts
    .flatMap((p) => (p.kind === 'text' ? [p.text] : []))
    .join('')
    .trim();
}

function persistable(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-MAX_MESSAGES).map((m) => {
    if (m.role === 'user') return { id: m.id, role: 'user', text: m.text, imageCount: m.imageCount };
    const changeSet = m.changeSet && {
      ...m.changeSet,
      fresh: [],
      morph: {},
      status: m.changeSet.status === 'applying' ? 'pending' : m.changeSet.status === 'undoing' ? 'applied' : m.changeSet.status === 'redoing' ? 'undone' : m.changeSet.status,
    };
    return { ...m, drafts: [], steps: closeSteps(m.steps), changeSet, state: m.state === 'streaming' ? 'stopped' : m.state };
  });
}

interface Env {
  ledger: LedgerStore;
  key: (name: string) => string;
}

export class AssistantStore {
  private state: AssistantState;
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private textBuffer = '';
  private frame = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private unseen: string[] = [];

  constructor(private readonly env: Env) {
    this.state = {
      messages: load<ChatMessage[]>(env.key('assistant'), []),
      streaming: false,
      autoRun: load<boolean>(env.key('assistant-auto'), false),
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getState = () => this.state;

  private set(patch: Partial<AssistantState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => save(this.env.key('assistant'), persistable(this.state.messages)), 400);
  }

  private update(id: string, fn: (m: AssistantMessage) => AssistantMessage) {
    this.set({ messages: this.state.messages.map((m) => (m.id === id && m.role === 'assistant' ? fn(m) : m)) });
  }

  pending() {
    return findPending(this.state.messages);
  }

  setAutoRun(autoRun: boolean) {
    save(this.env.key('assistant-auto'), autoRun);
    this.set({ autoRun });
  }

  clear() {
    this.stop();
    this.set({ messages: [] });
  }

  stop() {
    this.controller?.abort();
  }

  dispose() {
    this.stop();
    cancelAnimationFrame(this.frame);
    clearTimeout(this.saveTimer);
    save(this.env.key('assistant'), persistable(this.state.messages));
  }

  private history(): AssistantTurn[] {
    const turns: AssistantTurn[] = [];
    for (const m of this.state.messages) {
      if (m.role === 'assistant' && m.state === 'streaming') continue;
      const text =
        m.role === 'user'
          ? m.text || (m.imageCount ? t.imagesOnly : '')
          : [textOf(m), historyNote(m.changeSet)].filter(Boolean).join('\n');
      if (text) turns.push({ role: m.role, text: text.slice(0, LIMITS.assistantText) });
    }
    return turns.slice(-LIMITS.assistantHistory);
  }

  private me() {
    const payer = load<string | null>(this.env.key('payer'), null);
    return payer && this.env.ledger.getState().snapshot?.members.some((m) => m.id === payer) ? payer : null;
  }

  private request(images: string[]): AssistantRequest {
    const { snapshot } = this.env.ledger.getState();
    const members = snapshot?.members ?? [];
    const excluded = new Set(load<string[]>(this.env.key('excluded-participants'), []));
    const participants = members.filter((m) => !excluded.has(m.id)).map((m) => m.id);
    const live = this.pending();
    return {
      messages: this.history(),
      images,
      pending: live && OPEN.includes(live.set.status) ? live.set.changes : [],
      me: this.me(),
      participants: participants.length === members.length ? null : participants,
      today: today(),
    };
  }

  async send(text: string, images: string[] = [], carried: ChangeSet | null = null) {
    const trimmed = text.trim();
    if (this.state.streaming || (!trimmed && images.length === 0)) return;
    const user: UserMessage = { id: newId(), role: 'user', text: trimmed, images, imageCount: images.length };
    const reply: AssistantMessage = { id: newId(), role: 'assistant', parts: [], steps: [], drafts: [], changeSet: carried, state: 'streaming' };
    if (images.length > 0 && !this.me() && this.env.ledger.getState().snapshot?.members.length) {
      this.set({ messages: [...this.state.messages, user, { ...reply, state: 'done' as const, needsMe: true }].slice(-MAX_MESSAGES) });
      return;
    }
    const open = this.pending();
    if (!carried && open && OPEN.includes(open.set.status)) reply.changeSet = { ...open.set, fresh: [], morph: {}, carried: true };
    const messages = this.state.messages.map((m) =>
      m.role === 'assistant' && m.changeSet && OPEN.includes(m.changeSet.status) ? { ...m, changeSet: { ...m.changeSet, status: 'superseded' as const } } : m,
    );
    this.set({ messages: [...messages, user, reply].slice(-MAX_MESSAGES), streaming: true });
    const body = this.request(images);

    const controller = new AbortController();
    this.controller = controller;
    let finished = false;
    try {
      for await (const { event, data } of streamSse('/api/ledger/assistant', body, controller.signal, ownKeyHeaders())) {
        let parsed: AssistantEvent;
        try {
          parsed = { type: event, ...(JSON.parse(data) as object) } as AssistantEvent;
        } catch {
          continue;
        }
        if (parsed.type === 'done' || parsed.type === 'error') finished = true;
        this.receive(reply.id, parsed);
      }
      if (!finished) this.receive(reply.id, { type: 'done' });
    } catch (err) {
      this.flushText(reply.id);
      const ended = controller.signal.aborted ? { state: 'stopped' as const } : { state: 'error' as const, error: errorMessage(err) };
      this.update(reply.id, (m) => ({ ...m, drafts: [], steps: closeSteps(m.steps), ...ended }));
    } finally {
      this.controller = null;
      this.set({ streaming: false });
    }
    const latest = this.find(reply.id);
    if (this.state.autoRun && latest?.state === 'done' && this.pending()?.message.id === reply.id) void this.apply();
  }

  private find(id: string) {
    const m = this.state.messages.find((x) => x.id === id);
    return m?.role === 'assistant' ? m : undefined;
  }

  private flushText(id: string) {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const delta = this.textBuffer;
    this.textBuffer = '';
    if (!delta) return;
    this.update(id, (m) => {
      const last = m.parts.at(-1);
      const parts: Part[] = last?.kind === 'text' ? [...m.parts.slice(0, -1), { kind: 'text', text: last.text + delta }] : [...m.parts, { kind: 'text', text: delta }];
      return { ...m, parts };
    });
  }

  private receive(id: string, event: AssistantEvent) {
    if (event.type === 'text') {
      this.textBuffer += event.delta;
      if (!this.frame) this.frame = requestAnimationFrame(() => this.flushText(id));
      return;
    }
    this.flushText(id);
    switch (event.type) {
      case 'step':
        return this.update(id, (m) => {
          const exists = m.steps.some((s) => s.id === event.id);
          const step = { id: event.id, tool: event.tool, status: event.status };
          return { ...m, steps: exists ? m.steps.map((s) => (s.id === event.id ? step : s)) : [...m.steps, step] };
        });
      case 'draft':
        return this.update(id, (m) => {
          const exists = m.drafts.some((d) => d.key === event.key);
          return {
            ...m,
            drafts: exists
              ? m.drafts.map((d) => (d.key === event.key ? { key: d.key, fields: { ...d.fields, ...event.fields } } : d))
              : [...m.drafts, { key: event.key, fields: event.fields }],
          };
        });
      case 'discard':
        return this.update(id, (m) => ({ ...m, drafts: m.drafts.filter((d) => d.key !== event.key) }));
      case 'view':
        return this.update(id, (m) => ({ ...m, parts: [...m.parts, { kind: 'view', view: event.view }] }));
      case 'pending':
        return this.receivePending(id, event);
      case 'done':
        return this.update(id, (m) => ({ ...m, drafts: [], state: 'done' }));
      case 'error':
        return this.update(id, (m) => ({ ...m, drafts: [], steps: closeSteps(m.steps), state: 'error', error: event.message || t.error }));
    }
  }

  private receivePending(id: string, event: Extract<AssistantEvent, { type: 'pending' }>) {
    const previous = this.pending();
    const before = new Map((this.find(id)?.changeSet ?? previous?.set)?.changes.map((c) => [changeKey(c), JSON.stringify(c)]) ?? []);
    const fresh = event.changes.filter((c) => before.get(changeKey(c)) !== JSON.stringify(c)).map(changeKey);
    this.set({
      messages: this.state.messages.map((m) => {
        if (m.role !== 'assistant') return m;
        if (m.id !== id) {
          return m.changeSet && OPEN.includes(m.changeSet.status) ? { ...m, changeSet: { ...m.changeSet, status: 'superseded' } } : m;
        }
        if (m.changeSet && !OPEN.includes(m.changeSet.status)) return m;
        const morph = { ...(m.changeSet?.morph ?? {}) };
        if (event.replaces && fresh[0]) morph[fresh[0]] = event.replaces;
        return {
          ...m,
          drafts: event.replaces ? m.drafts.filter((d) => d.key !== event.replaces) : m.drafts,
          changeSet: {
            changes: event.changes,
            status: 'pending',
            dropped: [...(m.changeSet?.dropped ?? []), ...(event.dropped ?? [])],
            morph,
            fresh,
            carried: !!m.changeSet?.carried && fresh.length === 0,
          },
        };
      }),
    });
  }

  private patchSet(id: string, patch: Partial<ChangeSet>) {
    this.update(id, (m) => (m.changeSet ? { ...m, changeSet: { ...m.changeSet, ...patch } } : m));
  }

  editChange(id: string, change: Change) {
    const k = changeKey(change);
    this.update(id, (m) =>
      m.changeSet ? { ...m, changeSet: { ...m.changeSet, fresh: [], changes: m.changeSet.changes.map((c) => (changeKey(c) === k ? change : c)) } } : m,
    );
  }

  removeChange(id: string, key: string) {
    this.update(id, (m) => {
      if (!m.changeSet) return m;
      const changes = m.changeSet.changes.filter((c) => changeKey(c) !== key);
      return { ...m, changeSet: { ...m.changeSet, fresh: [], changes, status: changes.length ? m.changeSet.status : 'discarded' } };
    });
  }

  discard() {
    const current = this.pending();
    if (current) this.patchSet(current.message.id, { status: 'discarded', fresh: [] });
  }

  async apply() {
    const current = this.pending();
    if (!current || current.set.status === 'applying' || this.state.streaming) return;
    const { message, set } = current;
    this.patchSet(message.id, { status: 'applying', fresh: [] });
    try {
      const { undo } = await this.env.ledger.apply(set.changes, { via: 'assistant' });
      this.applied(message.id, set.changes, undo);
    } catch (err) {
      const stale =
        err instanceof ApiError &&
        (err.status === 409 || err.status === 404 || (err.status === 400 && referencesMissing(set.changes, this.env.ledger.getState().snapshot?.members ?? [])));
      if (stale) {
        this.patchSet(message.id, { status: 'conflict', error: errorMessage(err) });
      } else {
        this.patchSet(message.id, { status: 'pending' });
        toast.error(errorMessage(err));
      }
    }
  }

  private applied(id: string, changes: Change[], undo: Change[]) {
    this.patchSet(id, { status: 'applied', applied: changes.length, undo, redo: undefined });
    this.unseen = changes.filter((c) => !c.op.endsWith('.delete')).map((c) => c.id);
    highlight(this.unseen);
    toast.success(t.appliedToast(changes.length), {
      icon: '✨',
      action: undo.length ? { label: common.undo, onClick: () => void this.undo(id) } : undefined,
    });
  }

  revealChanges() {
    highlight(this.unseen);
    this.unseen = [];
  }

  async undo(id: string) {
    const set = this.find(id)?.changeSet;
    if (!set?.undo || set.status !== 'applied') return;
    this.patchSet(id, { status: 'undoing' });
    try {
      const { undo: redo } = await this.env.ledger.apply(set.undo);
      this.unseen = [];
      this.patchSet(id, { status: 'undone', redo });
      toast.success(common.undone);
    } catch (err) {
      this.patchSet(id, { status: 'applied' });
      toast.error(errorMessage(err));
    }
  }

  async redo(id: string) {
    const set = this.find(id)?.changeSet;
    if (!set?.redo?.length || set.status !== 'undone') return;
    this.patchSet(id, { status: 'redoing' });
    try {
      const { undo } = await this.env.ledger.apply(set.redo, { via: 'assistant' });
      this.applied(id, set.changes, undo);
    } catch (err) {
      this.patchSet(id, { status: 'undone' });
      toast.error(errorMessage(err));
    }
  }

  private promptOf(id: string) {
    const index = this.state.messages.findIndex((m) => m.id === id);
    const user = this.state.messages[index - 1];
    return index > 0 && user?.role === 'user' ? user : null;
  }

  canResend(id: string) {
    const user = this.promptOf(id);
    return !!user && !lostImages(user) && (!!user.text || user.imageCount > 0);
  }

  retry(id: string) {
    const user = this.promptOf(id);
    const reply = this.find(id);
    if (this.state.streaming || !user || !reply || !this.canResend(id)) return;
    const set = reply.changeSet;
    const carried = set && set.changes.length > 0 && OPEN.includes(set.status) ? { ...set, fresh: [], morph: {} } : null;
    this.set({ messages: this.state.messages.filter((m) => m !== user && m.id !== id) });
    void this.send(user.text, user.images ?? [], carried);
  }

  recheck() {
    void this.send(t.recheckMessage);
  }
}
