import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpgradeWebSocket } from 'hono/ws';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_ROUNDS } from '../src/server/ai/assistant.ts';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { createNodePlatform } from '../src/server/node/platform.ts';
import type { AssistantEvent } from '../src/shared/assistant.ts';
import { newId } from '../src/shared/ids.ts';
import { dsCall, dsFinish, dsText, dsThink, dsUsage, stubDeepSeek } from './helpers/deepseek.ts';
import { start, stop as claudeStop, stubClaude, textBlock, thinkingBlock, toolBlock } from './helpers/claude.ts';
import { call, parts, stubGemini, text, type Chunk } from './helpers/gemini.ts';

const dir = mkdtempSync(join(tmpdir(), 'aapay-assistant-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

const TODAY = '2026-10-07';
const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

function parseSse(raw: string) {
  return raw
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))!.slice(7);
      const data = JSON.parse(lines.find((l) => l.startsWith('data: '))!.slice(6)) as AssistantEvent;
      expect(data.type).toBe(event);
      return data;
    });
}

async function setup(env: Record<string, string> = { GEMINI_API_KEY: 'test-key' }, idleTimeout?: number) {
  const loaded = loadConfig({ ADMIN_AUTH: 'none', ...env });
  const config = idleTimeout && loaded.assistant ? { ...loaded, assistant: { ...loaded.assistant, idleTimeout } } : loaded;
  const platform = createNodePlatform(join(dir, crypto.randomUUID()), (() => undefined) as unknown as UpgradeWebSocket);
  const app = createApp(async (c, next) => {
    c.set('config', config);
    c.set('platform', platform);
    await next();
  });
  const cookies = new Map<string, string>();
  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`http://aapay.test/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [k, v] = c.split(';')[0]!.split('=');
      if (v) cookies.set(k!, v);
      else cookies.delete(k!);
    }
    return res;
  };
  const json = async (method: string, path: string, body?: unknown) => (await (await request(method, path, body)).json()) as any;

  await request('GET', '/admin/login');
  const ledger = await json('POST', '/admin/ledgers', { name: '周末露营' });
  await json('POST', `/admin/ledgers/${ledger.id}/passphrases`, { code: 'Camp2026', validUntil: null });
  cookies.clear();
  await request('POST', '/join', { code: 'Camp2026' });

  const ids = { me: newId(), wang: newId(), yu: newId(), li: newId() };
  await json('POST', '/ledger/changes', {
    changes: [
      { op: 'member.create', id: ids.me, member: { name: '阿杰' } },
      { op: 'member.create', id: ids.wang, member: { name: '老王' } },
      { op: 'member.create', id: ids.yu, member: { name: '小雨' } },
      { op: 'member.create', id: ids.li, member: { name: '小李' } },
    ],
  });

  const ask = async (body: Record<string, unknown>, locale = 'zh-CN', headers: Record<string, string> = {}) => {
    const res = await request(
      'POST',
      '/ledger/assistant',
      { messages: [{ role: 'user', text: '你好' }], me: ids.me, participants: null, today: TODAY, ...body },
      { 'accept-language': locale, ...headers },
    );
    const raw = await res.text();
    return { res, raw, events: res.headers.get('content-type')?.startsWith('text/event-stream') ? parseSse(raw) : [] };
  };
  const snapshot = () => json('GET', '/ledger');
  return { ask, request, json, snapshot, ids, ledger };
}

const ofType = <T extends AssistantEvent['type']>(events: AssistantEvent[], type: T) =>
  events.filter((e): e is Extract<AssistantEvent, { type: T }> => e.type === type);

describe('assistant endpoint', () => {
  it('streams text deltas between an initial pending and done', async () => {
    const requests = stubGemini([[text('你好'), text('，要记'), text('什么？')]]);
    const { ask, ledger } = await setup();
    const { res, events } = await ask({});
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(events).toEqual([
      { type: 'pending', changes: [] },
      { type: 'text', delta: '你好' },
      { type: 'text', delta: '，要记' },
      { type: 'text', delta: '什么？' },
      { type: 'done' },
    ]);

    const body = requests[0]!.body;
    expect(requests[0]!.url).toContain('/models/gemini-flash-lite-latest:streamGenerateContent?alt=sse');
    const system = body.systemInstruction.parts[0].text as string;
    expect(system).toContain(`"${ledger.name}"`);
    expect(system).toContain('"老王"');
    expect(system).toContain('The user is "阿杰"');
    expect(system).toContain(`Today is ${TODAY}`);
    expect(system).toContain('Simplified Chinese');
    const names = body.tools[0].functionDeclarations.map((d: { name: string }) => d.name);
    expect(names).toEqual([
      'get_ledger',
      'list_transactions',
      'list_activity',
      'add_expense',
      'update_expense',
      'delete_expense',
      'add_member',
      'update_member',
      'record_settlement',
      'delete_settlement',
      'show',
    ]);
    expect(body.tools[0].functionDeclarations[3].parametersJsonSchema.properties.amount.type).toBe('number');
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '你好' }] }]);
    expect(body).not.toHaveProperty('toolConfig');
  });

  it('reads the confirmed ledger, lists pending proposals apart and sends model parts back verbatim', async () => {
    const first: Chunk[] = [
      call('get_ledger', {}, { id: 'c1', thoughtSignature: 'sig-1' }),
      call('list_transactions', { member: '小雨' }, { id: 'c2' }),
      parts({ text: '', thoughtSignature: 'sig-2' }),
    ];
    const requests = stubGemini([first, [text('小雨还没有支出。')]]);
    const { ask, ids } = await setup();
    const pending = [
      {
        op: 'expense.create',
        id: newId(),
        expense: { title: '打车', amount: 3500, payerId: ids.yu, date: TODAY, category: 'transport', split: { mode: 'even', memberIds: [ids.yu, ids.wang] } },
      },
    ];
    const { events } = await ask({ messages: [{ role: 'user', text: '小雨花了多少' }], pending });
    expect(events.map((e) => e.type)).toEqual(['pending', 'step', 'step', 'step', 'step', 'text', 'done']);
    expect(ofType(events, 'step')).toEqual([
      { type: 'step', id: 'c1', tool: 'get_ledger', status: 'start' },
      { type: 'step', id: 'c1', tool: 'get_ledger', status: 'done' },
      { type: 'step', id: 'c2', tool: 'list_transactions', status: 'start' },
      { type: 'step', id: 'c2', tool: 'list_transactions', status: 'done' },
    ]);

    const second = requests[1]!.body.contents;
    expect(second).toHaveLength(3);
    expect(second[1]).toEqual({ role: 'model', parts: first.flatMap((c) => c.candidates![0]!.content!.parts!) });
    expect(second[1].parts[0].thoughtSignature).toBe('sig-1');
    const [ledgerReply, listReply] = second[2].parts;
    expect(second[2].role).toBe('user');
    expect(ledgerReply.functionResponse).toMatchObject({
      id: 'c1',
      name: 'get_ledger',
      response: { summary: { expenseCount: 0, totalSpent: 0 }, pendingChanges: [{ op: 'expense.create', id: pending[0]!.id }] },
    });
    expect(ledgerReply.functionResponse.response.pendingChanges[0].summary).toContain('打车');
    expect(listReply.functionResponse).toMatchObject({ id: 'c2', name: 'list_transactions', response: { matched: 0, pendingChanges: [{ id: pending[0]!.id }] } });
  });

  it('proposes changes one by one and lets the model fix a rejected proposal', async () => {
    const requests = stubGemini([
      [
        call('add_expense', { title: '晚饭', amount: 128, payer: '阿杰', date: '2026-10-06' }, { id: 'a1', thoughtSignature: 's' }),
        call('add_expense', { title: '打车', amount: 35, payer: '小王', participants: ['小雨', '老王'] }, { id: 'a2' }),
      ],
      [call('add_expense', { title: '打车', amount: 35, payer: '小雨', participants: ['小雨', '老王'] }, { id: 'a3' })],
      [text('确认后记入这两笔。')],
    ]);
    const { ask, ids, snapshot } = await setup();
    const { events } = await ask({ messages: [{ role: 'user', text: '昨天晚饭 128 我付的；小雨打车 35 只有她和老王' }] });

    const pending = ofType(events, 'pending');
    expect(pending.map((p) => p.changes.length)).toEqual([0, 1, 2]);
    expect(pending.every((p) => p.replaces === undefined && p.dropped === undefined)).toBe(true);
    const [dinner, taxi] = pending[2]!.changes;
    expect(dinner).toMatchObject({
      op: 'expense.create',
      expense: { title: '晚饭', amount: 12800, payerId: ids.me, date: '2026-10-06', category: 'food', split: { mode: 'even', memberIds: [ids.me, ids.wang, ids.yu, ids.li] } },
    });
    expect(taxi).toMatchObject({ op: 'expense.create', expense: { amount: 3500, payerId: ids.yu, date: TODAY, category: 'transport', split: { mode: 'even', memberIds: [ids.yu, ids.wang] } } });
    expect(pending[1]!.changes[0]).toEqual(dinner);

    expect(ofType(events, 'step').map((s) => `${s.id}:${s.status}`)).toEqual(['a1:start', 'a1:done', 'a2:start', 'a2:error', 'a3:start', 'a3:done']);
    const replies = requests[1]!.body.contents[2].parts.map((p: any) => p.functionResponse);
    expect(replies[0]).toMatchObject({ id: 'a1', response: { status: 'proposed', id: dinner!.id, created: { title: '晚饭', amount: 128, payer: '阿杰' } } });
    expect(replies[1]).toMatchObject({ id: 'a2', response: { error: expect.stringContaining('No member named "小王"') } });
    expect(requests[2]!.body.contents[4].parts[0].functionResponse.response).toMatchObject({ status: 'proposed', created: { payer: '小雨' } });
    expect(ofType(events, 'text')).toEqual([{ type: 'text', delta: '确认后记入这两笔。' }]);

    expect((await snapshot()).expenses).toEqual([]);
  });

  it('folds proposals into the pending changes', async () => {
    const { ask, ids, json } = await setup();
    const existing = newId();
    await json('POST', '/ledger/changes', {
      changes: [
        { op: 'expense.create', id: existing, expense: { title: '营地', amount: 20000, payerId: ids.me, date: '2026-10-01', category: 'lodging', split: { mode: 'even', memberIds: [ids.me, ids.wang] } } },
      ],
    });
    const real = (await json('GET', '/ledger')).expenses[0];
    const draftId = newId();
    const created = {
      op: 'expense.create',
      id: draftId,
      expense: { title: '咖啡', amount: 1800, payerId: ids.me, date: TODAY, category: 'food', split: { mode: 'even', memberIds: [ids.me] } },
    };
    const requests = stubGemini([
      [
        call('update_expense', { id: draftId, amount: 20 }, { id: 'u1' }),
        call('update_expense', { id: existing, title: '营地费' }, { id: 'u2' }),
        call('update_expense', { id: existing, title: '露营地' }, { id: 'u3' }),
      ],
      [call('delete_expense', { id: existing }, { id: 'd1' }), call('add_member', { name: '小周' }, { id: 'm1' })],
      [call('update_member', { member: '小周', name: '周周' }, { id: 'm2' }), call('delete_expense', { id: draftId }, { id: 'd2' })],
      [text('好了。')],
    ]);
    const { events } = await ask({ pending: [created] });
    const pending = ofType(events, 'pending').map((p) => p.changes);
    expect(pending[1]).toEqual([{ ...created, expense: { ...created.expense, amount: 2000 } }]);
    expect(pending[2]![1]).toMatchObject({ op: 'expense.update', id: existing, expense: { title: '营地费' }, ifUpdatedAt: real.updatedAt });
    expect(pending[3]).toHaveLength(2);
    expect(pending[3]![1]).toMatchObject({ op: 'expense.update', id: existing, expense: { title: '露营地' }, ifUpdatedAt: real.updatedAt });
    expect(pending[4]![1]).toEqual({ op: 'expense.delete', id: existing, ifUpdatedAt: real.updatedAt });
    expect(pending[5]![2]).toMatchObject({ op: 'member.create', member: { name: '小周' } });
    const final = pending.at(-1)!;
    expect(final).toHaveLength(2);
    expect(final[0]).toEqual({ op: 'expense.delete', id: existing, ifUpdatedAt: real.updatedAt });
    expect(final[1]).toMatchObject({ op: 'member.create', member: { name: '周周' } });
    expect(ofType(events, 'step').every((s) => s.status !== 'error')).toBe(true);
    expect(requests[1]!.body.contents[2].parts[2].functionResponse.response).toMatchObject({ status: 'proposed', before: { title: '营地费' }, after: { title: '露营地' } });
  });

  it('adds a member created afterwards to earlier proposed expenses', async () => {
    const { ask, ids, json } = await setup();
    const existing = newId();
    await json('POST', '/ledger/changes', {
      changes: [
        { op: 'expense.create', id: existing, expense: { title: '营地', amount: 20000, payerId: ids.me, date: '2026-10-01', category: null, split: { mode: 'even', memberIds: [ids.me] } } },
      ],
    });
    const requests = stubGemini((body, index) => {
      if (index === 0) {
        return [
          call('add_expense', { title: '晚饭', amount: 100, payer: '阿杰', participants: ['阿杰'] }, { id: 'a1' }),
          call('update_expense', { id: existing, title: '露营地' }, { id: 'u1' }),
          call('add_member', { name: '小周' }, { id: 'm1' }),
        ];
      }
      if (index === 1) {
        const created = body.contents[2].parts[0].functionResponse.response.id as string;
        return [
          call('update_expense', { id: created, participants: ['阿杰', '小周'] }, { id: 'u2' }),
          call('update_expense', { id: existing, participants: ['阿杰', '小周'] }, { id: 'u3' }),
        ];
      }
      return [text('好了。')];
    });
    const { events } = await ask({ messages: [{ role: 'user', text: '晚饭和营地都加上新来的小周' }] });

    expect(ofType(events, 'step').filter((s) => s.status === 'error')).toEqual([]);
    expect(requests[2]!.body.contents[4].parts.map((p: any) => p.functionResponse.response.status)).toEqual(['proposed', 'proposed']);
    const final = ofType(events, 'pending').at(-1)!.changes;
    expect(final.map((c) => c.op)).toEqual(['member.create', 'expense.create', 'expense.update']);
    const zhou = final[0]!.id;
    expect(final[1]).toMatchObject({ expense: { title: '晚饭', split: { mode: 'even', memberIds: [ids.me, zhou] } } });
    expect(final[2]).toMatchObject({ id: existing, expense: { title: '露营地', split: { mode: 'even', memberIds: [ids.me, zhou] } } });
  });

  it('drops invalid pending changes and explains why in the request language', async () => {
    const { ask, ids, json } = await setup();
    const existing = newId();
    await json('POST', '/ledger/changes', {
      changes: [
        { op: 'expense.create', id: existing, expense: { title: '营地', amount: 20000, payerId: ids.me, date: '2026-10-01', category: null, split: { mode: 'even', memberIds: [ids.me] } } },
      ],
    });
    const good = { op: 'member.create', id: newId(), member: { name: '小周' } };
    const ghostPayer = { op: 'expense.create', id: newId(), expense: { title: '饭', amount: 100, payerId: 'nobody-here', date: TODAY, category: null, split: { mode: 'even', memberIds: [ids.me] } } };
    const stale = { op: 'expense.delete', id: existing, ifUpdatedAt: 1 };
    const missing = { op: 'settlement.delete', id: newId() };
    const later = { op: 'member.update', id: good.id, member: { name: '周周' } };

    const requests = stubGemini(() => [text('ok')]);
    const zh = (await ask({ pending: [good, ghostPayer, stale, missing, later] })).events[0];
    expect(zh).toEqual({
      type: 'pending',
      changes: [good, later],
      dropped: [
        { id: ghostPayer.id, reason: '付款人不存在' },
        { id: existing, reason: '这笔账刚被改过，请刷新后再试' },
        { id: missing.id, reason: '这笔还款不存在或已被删除' },
      ],
    });
    expect(requests[0]!.body.systemInstruction.parts[0].text).toContain(`member.create id ${good.id}: add member "小周"`);
    const en = (await ask({ pending: [ghostPayer] }, 'en-US')).events[0];
    expect(en).toEqual({ type: 'pending', changes: [], dropped: [{ id: ghostPayer.id, reason: 'Payer not found' }] });
  });

  it('streams image drafts, folds finished items and discards bad ones', async () => {
    const extraction = JSON.stringify({
      items: [
        { title: '瑞幸咖啡', amount: 18.5, date: '2026-10-01', category: 'food' },
        { title: '退款', amount: 0, date: null, category: 'other' },
        { title: '滴滴出行', amount: 23.8, date: null, category: 'transport' },
      ],
    });
    const pieces = extraction.match(/.{1,2}/gs)!;
    const requests = stubGemini([pieces.map(text), [text('识别到 2 笔，确认后记入。')]]);
    const { ask, ids } = await setup();
    const { events } = await ask({ images: [IMAGE], participants: [ids.me, ids.yu, 'gone-member'], messages: [{ role: 'user', text: '' }] });

    expect(events[0]).toEqual({ type: 'pending', changes: [] });
    expect(events[1]).toEqual({ type: 'step', id: 'read_images', tool: 'read_images', status: 'start' });
    const drafts = ofType(events, 'draft');
    expect(drafts.filter((d) => d.key === 'd0').map((d) => d.fields)).toContainEqual({ title: '瑞幸' });
    expect(drafts.filter((d) => d.key === 'd0').at(-1)!.fields).toMatchObject({ title: '瑞幸咖啡', amount: 18.5 });
    expect(drafts.every((d) => d.fields.date === undefined || d.fields.date === null || /^\d{4}-\d{2}-\d{2}$/.test(d.fields.date))).toBe(true);

    const pending = ofType(events, 'pending');
    expect(pending.map((p) => [p.replaces, p.changes.length])).toEqual([
      [undefined, 0],
      ['d0', 1],
      ['d2', 2],
    ]);
    expect(pending[1]!.changes[0]).toMatchObject({
      op: 'expense.create',
      expense: { title: '瑞幸咖啡', amount: 1850, payerId: ids.me, date: '2026-10-01', category: 'food', split: { mode: 'even', memberIds: [ids.me, ids.yu] } },
    });
    expect(pending[2]!.changes[1]).toMatchObject({ expense: { title: '滴滴出行', amount: 2380, date: TODAY, category: 'transport' } });
    expect(ofType(events, 'discard')).toEqual([{ type: 'discard', key: 'd1' }]);
    const steps = ofType(events, 'step');
    expect(steps.at(-1)).toEqual({ type: 'step', id: 'read_images', tool: 'read_images', status: 'done' });
    expect(events.indexOf(steps.at(-1)!)).toBeLessThan(events.findIndex((e) => e.type === 'text'));
    expect(events.at(-1)).toEqual({ type: 'done' });

    const [extract, dialog] = requests.map((r) => r.body);
    expect(extract.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } });
    expect(extract.generationConfig).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: { required: ['items'] } });
    expect(Object.keys(extract.generationConfig.responseJsonSchema.properties.items.items.properties)).toEqual(['title', 'amount', 'date', 'category']);
    expect(extract).not.toHaveProperty('tools');
    expect(JSON.stringify(dialog.contents)).not.toContain('inlineData');
    expect(dialog.contents.at(-1).parts.at(-1).text).toContain('the 2 expense(s) found in them are in the pending changes');
    expect(dialog.systemInstruction.parts[0].text).toContain('add expense "瑞幸咖啡" 18.5 CNY');
  });

  it('passes images to the conversation when the user is not a member', async () => {
    const requests = stubGemini([[text('这是谁付的？')]]);
    const { ask } = await setup();
    const { events } = await ask({ images: [IMAGE], me: null, messages: [{ role: 'user', text: '记一下' }] });
    expect(events.map((e) => e.type)).toEqual(['pending', 'text', 'done']);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.contents[0].parts).toEqual([{ text: '记一下' }, { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }]);
    expect(requests[0]!.body.systemInstruction.parts[0].text).toContain('The user has not said which member they are');
  });

  it('treats an unknown me like no member and passes images to the conversation', async () => {
    const requests = stubGemini([[text('这是谁付的？')]]);
    const { ask } = await setup();
    const { events } = await ask({ images: [IMAGE], me: newId(), messages: [{ role: 'user', text: '记一下' }] });
    expect(events.map((e) => e.type)).toEqual(['pending', 'text', 'done']);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.contents[0].parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } });
  });

  it('turns show calls into views', async () => {
    stubGemini([
      [
        call('show', { view: 'transactions', member: '小雨', category: 'food', from: '2026-10-01' }, { id: 's1' }),
        call('show', { view: 'settle' }, { id: 's2' }),
        call('show', { view: 'trend', member: '路人' }, { id: 's3' }),
      ],
      [text('看这里。')],
    ]);
    const { ask, ids } = await setup();
    const { events } = await ask({ messages: [{ role: 'user', text: '这周谁花得最多' }] });
    expect(ofType(events, 'view')).toEqual([
      { type: 'view', view: { kind: 'transactions', memberId: ids.yu, category: 'food', query: null, from: '2026-10-01', to: null } },
      { type: 'view', view: { kind: 'settle' } },
    ]);
    expect(ofType(events, 'step').map((s) => s.status)).toEqual(['start', 'done', 'start', 'done', 'start', 'error']);
  });

  it('stops calling tools after the last round', async () => {
    const requests = stubGemini((_, i) => [call('get_ledger', {}, { id: `r${i}` })]);
    const { ask } = await setup();
    const { events } = await ask({});
    expect(requests).toHaveLength(MAX_ROUNDS);
    expect(requests.at(-1)!.body.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    expect(requests.slice(0, -1).every((r) => r.body.toolConfig === undefined)).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('reports upstream failures as an error event', async () => {
    stubGemini([Response.json({ error: { message: 'User location is not supported' } }, { status: 400 })]);
    const { ask } = await setup();
    expect((await ask({})).events).toEqual([
      { type: 'pending', changes: [] },
      { type: 'error', message: 'AI 助手暂时不可用，请稍后再试' },
    ]);

    stubGemini([[text('写到一半'), { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }]]);
    expect((await ask({}, 'en')).events.slice(1)).toEqual([
      { type: 'text', delta: '写到一半' },
      { type: 'error', message: 'The AI assistant is temporarily unavailable. Please try again later' },
    ]);

    stubGemini([Response.json({}, { status: 429 })]);
    expect((await ask({})).events.at(-1)).toEqual({ type: 'error', message: 'AI 助手太忙了，请稍后再试' });

    stubGemini([[text('{"items":[')], []]);
    const extraction = await ask({ images: [IMAGE] });
    expect(extraction.events.map((e) => e.type)).toEqual(['pending', 'step', 'step', 'done']);

    stubGemini([Response.json({}, { status: 500 })]);
    expect((await ask({ images: [IMAGE] })).events).toEqual([
      { type: 'pending', changes: [] },
      { type: 'step', id: 'read_images', tool: 'read_images', status: 'start' },
      { type: 'step', id: 'read_images', tool: 'read_images', status: 'error' },
      { type: 'error', message: 'AI 助手暂时不可用，请稍后再试' },
    ]);
  });

  it('reports a quiet upstream as a timeout instead of hanging', async () => {
    const hang = (first: string[] = []) =>
      vi.stubGlobal('fetch', async () => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const piece of first) controller.enqueue(encoder.encode(piece));
            },
          }),
        );
      });
    const { ask } = await setup(undefined, 50);

    hang();
    expect((await ask({})).events).toEqual([
      { type: 'pending', changes: [] },
      { type: 'error', message: 'AI 助手响应超时，请重试' },
    ]);

    hang([`data: ${JSON.stringify(text('写到一半'))}\r\n\r\n`]);
    expect((await ask({}, 'en')).events.slice(1)).toEqual([
      { type: 'text', delta: '写到一半' },
      { type: 'error', message: 'The AI assistant took too long to respond. Please try again' },
    ]);

    hang();
    expect((await ask({ images: [IMAGE] })).events).toEqual([
      { type: 'pending', changes: [] },
      { type: 'step', id: 'read_images', tool: 'read_images', status: 'start' },
      { type: 'step', id: 'read_images', tool: 'read_images', status: 'error' },
      { type: 'error', message: 'AI 助手响应超时，请重试' },
    ]);
  });

  it('stops reading images and running tools when the client goes away', async () => {
    const upstream: AbortSignal[] = [];
    vi.stubGlobal('fetch', async (_: string, init: RequestInit) => {
      upstream.push(init.signal!);
      const encoder = new TextEncoder();
      const first = upstream.length === 1 ? '{"items":[{"title":"咖啡","amount":18' : '';
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(text(first))}\r\n\r\n`));
          },
        }),
      );
    });
    const { request, ids } = await setup();
    const res = await request('POST', '/ledger/assistant', { messages: [{ role: 'user', text: '' }], images: [IMAGE], me: ids.me, participants: null, today: TODAY });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: draft')) seen += decoder.decode((await reader.read()).value);
    await reader.cancel();
    await vi.waitFor(() => expect(upstream[0]!.aborted).toBe(true));
    expect(upstream).toHaveLength(1);

    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', async (_: string, init: RequestInit) => {
      signals.push(init.signal!);
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(call('get_ledger', {}, { id: 'g1' }))}\r\n\r\n`));
          },
        }),
      );
    });
    const second = await request('POST', '/ledger/assistant', { messages: [{ role: 'user', text: '你好' }], me: ids.me, participants: null, today: TODAY });
    const reader2 = second.body!.getReader();
    seen = '';
    while (!seen.includes('event: step')) seen += decoder.decode((await reader2.read()).value);
    await reader2.cancel();
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signals).toHaveLength(1);
  });

  it('aborts the upstream request when the client goes away', async () => {
    let upstream: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_: string, init: RequestInit) => {
      upstream = init.signal!;
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(text('开头'))}\r\n\r\n`));
            upstream!.addEventListener('abort', () => controller.error(upstream!.reason));
          },
        }),
      );
    });
    const { request } = await setup();
    const res = await request('POST', '/ledger/assistant', { messages: [{ role: 'user', text: '你好' }], me: null, participants: null, today: TODAY });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: text')) seen += decoder.decode((await reader.read()).value);
    expect(upstream!.aborted).toBe(false);
    await reader.cancel();
    await vi.waitFor(() => expect(upstream!.aborted).toBe(true));
  });

  it('validates the request, limits the rate and needs a key', async () => {
    stubGemini(() => [text('ok')]);
    const { ask, request } = await setup();
    const bad = await request('POST', '/ledger/assistant', { messages: [{ role: 'assistant', text: 'hi' }], me: null, participants: null, today: TODAY });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: '参数错误' });
    expect((await ask({ images: ['https://example.com/a.png'] })).res.status).toBe(400);
    expect((await ask({ messages: [] })).res.status).toBe(400);

    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await ask({})).res.status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(JSON.parse((await ask({})).raw)).toEqual({ error: 'AI 助手太忙了，请稍后再试' });

    const off = await setup({ ASSISTANT: 'disabled' });
    expect(await off.json('GET', '/config')).toMatchObject({ assistant: null });
    const disabled = await off.ask({});
    expect(disabled.res.status).toBe(404);
    expect(JSON.parse(disabled.raw)).toEqual({ error: '未启用 AI 助手' });
    expect(await (await setup()).json('GET', '/config')).toMatchObject({
      assistant: { provider: 'gemini', builtin: true, models: { gemini: 'gemini-flash-lite-latest', deepseek: 'deepseek-flash', claude: 'claude-haiku-5-5', openai: '' } },
    });
  });
});

describe('bring your own key', () => {
  const OWN = 'AQ.own-key-0123456789abcdef';
  const own = (provider: string, extra: Record<string, string> = {}) => ({ 'x-ai-provider': provider, 'x-ai-key': OWN, ...extra });

  it('uses the key and model from the request headers over the built-in ones', async () => {
    const requests = stubGemini([[text('好')]]);
    const { ask } = await setup();
    const { events } = await ask({}, 'zh-CN', own('gemini', { 'x-ai-model': 'gemini-9-pro' }));
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(requests[0]!.headers['x-goog-api-key']).toBe(OWN);
    expect(requests[0]!.url).toContain('/models/gemini-9-pro:streamGenerateContent');
  });

  it('switches provider with the user key, defaulting to that provider model', async () => {
    const requests = stubDeepSeek([[dsText('好'), dsFinish('stop')]]);
    const { ask } = await setup();
    const { events } = await ask({}, 'zh-CN', own('deepseek'));
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(requests[0]!.url).toBe('https://api.deepseek.com/chat/completions');
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${OWN}`);
    expect(requests[0]!.body.model).toBe('deepseek-flash');
  });

  it('ignores provider and model headers without an own key', async () => {
    const requests = stubGemini([[text('好')]]);
    const { ask } = await setup();
    await ask({}, 'zh-CN', { 'x-ai-provider': 'deepseek', 'x-ai-model': 'gemini-9-pro' });
    expect(requests[0]!.headers['x-goog-api-key']).toBe('test-key');
    expect(requests[0]!.url).toContain('/models/gemini-flash-lite-latest:');
  });

  it('asks for a key when the server has none for its provider', async () => {
    stubGemini([]);
    const { ask, json } = await setup({ ASSISTANT_PROVIDER: 'deepseek', GEMINI_API_KEY: 'test-key' });
    expect((await json('GET', '/config')).assistant).toEqual({ provider: 'deepseek', builtin: false, models: { gemini: 'gemini-flash-lite-latest', deepseek: 'deepseek-flash', claude: 'claude-haiku-5-5', openai: '' } });
    const { res, raw } = await ask({});
    expect(res.status).toBe(400);
    expect(JSON.parse(raw)).toEqual({ error: '请先填写你的 API Key' });
  });

  it('turns the assistant off entirely with ASSISTANT=disabled', async () => {
    const { ask, json } = await setup({ ASSISTANT: 'disabled', GEMINI_API_KEY: 'test-key' });
    expect((await json('GET', '/config')).assistant).toBeNull();
    expect((await ask({}, 'zh-CN', own('gemini'))).res.status).toBe(404);
  });

  it('rejects malformed providers, keys and models before calling upstream', async () => {
    const requests = stubGemini([]);
    const { ask } = await setup({});
    expect((await ask({}, 'zh-CN', { 'x-ai-key': OWN })).res.status).toBe(400);
    expect((await ask({}, 'zh-CN', own('openai'))).res.status).toBe(400);
    expect((await ask({}, 'zh-CN', { 'x-ai-provider': 'gemini', 'x-ai-key': 'short' })).res.status).toBe(400);
    expect((await ask({}, 'zh-CN', own('gemini', { 'x-ai-model': '../files' }))).res.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('reports upstream key problems in terms of the user key', async () => {
    stubGemini([
      new Response(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }), { status: 400 }),
      new Response('{}', { status: 429 }),
    ]);
    const { ask } = await setup({});
    expect((await ask({}, 'zh-CN', own('gemini'))).events.at(-1)).toEqual({ type: 'error', message: 'API Key 无效' });
    expect((await ask({}, 'zh-CN', own('gemini'))).events.at(-1)).toEqual({ type: 'error', message: '你的 API Key 余额不足或请求太频繁' });

    stubDeepSeek([
      Response.json({ error: { message: 'Authentication Fails' } }, { status: 401 }),
      Response.json({ error: { message: 'Insufficient Balance' } }, { status: 402 }),
      Response.json({ error: { message: 'Model Not Exist' } }, { status: 400 }),
    ]);
    expect((await ask({}, 'zh-CN', own('deepseek'))).events.at(-1)).toEqual({ type: 'error', message: 'API Key 无效' });
    expect((await ask({}, 'zh-CN', own('deepseek'))).events.at(-1)).toEqual({ type: 'error', message: '你的 API Key 余额不足或请求太频繁' });
    expect((await ask({}, 'zh-CN', own('deepseek'))).events.at(-1)).toEqual({ type: 'error', message: '找不到这个模型' });
  });

  it('checks a key against the chosen model without generating anything', async () => {
    const requests = stubGemini([new Response('{}'), new Response('{}', { status: 404 })]);
    const { request } = await setup({});
    const ok = await request('POST', '/ledger/assistant/key', undefined, own('gemini'));
    expect(await ok.json()).toEqual({ provider: 'gemini', model: 'gemini-flash-lite-latest' });
    expect(requests[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest');
    expect(requests[0]!.headers['x-goog-api-key']).toBe(OWN);
    const missing = await request('POST', '/ledger/assistant/key', undefined, own('gemini', { 'x-ai-model': 'gemini-nope' }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: '找不到这个模型' });
    expect((await request('POST', '/ledger/assistant/key')).status).toBe(400);
  });

  it('checks a DeepSeek key with a one-token request', async () => {
    const error = (status: number, message: string) => Response.json({ error: { message } }, { status });
    const requests = stubDeepSeek([Response.json({ choices: [] }), error(400, 'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-nope.'), error(401, 'Authentication Fails'), error(402, 'Insufficient Balance')]);
    const { request } = await setup({});
    expect(await (await request('POST', '/ledger/assistant/key', undefined, own('deepseek'))).json()).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
    expect(requests[0]).toMatchObject({ url: 'https://api.deepseek.com/chat/completions', method: 'POST', body: { model: 'deepseek-flash', max_tokens: 1 } });
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${OWN}`);
    const errorOf = async () => ((await (await request('POST', '/ledger/assistant/key', undefined, own('deepseek'))).json()) as { error: string }).error;
    expect(await errorOf()).toBe('找不到这个模型');
    expect(await errorOf()).toBe('API Key 无效');
    expect(await errorOf()).toBe('你的 API Key 余额不足或请求太频繁');
  });

  it('reports a key check that times out as 504', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const { request } = await setup({});
    const res = await request('POST', '/ledger/assistant/key', undefined, own('gemini'));
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: 'AI 助手响应超时，请重试' });
  });
});

describe('assistant on DeepSeek', () => {
  const env = { ASSISTANT_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-site-key-0123456789' };

  it('runs the tool loop, proposes cards one by one and echoes reasoning within the turn', async () => {
    const requests = stubDeepSeek([
      [
        dsThink('两笔'),
        dsCall(0, { id: 'call_a', name: 'add_expense', args: '{"title":"早' }),
        dsCall(0, { args: '餐","amount":18,"payer":"阿杰"}' }),
        dsCall(1, { id: 'call_b', name: 'add_expense', args: '{"title":"咖啡","amount":25,"payer":"阿杰"}' }),
        dsFinish('tool_calls'),
        dsUsage,
      ],
      [dsText('两笔都拟好了，'), dsText('确认后记入。'), dsFinish('stop')],
    ]);
    const { ask, ids } = await setup(env);
    const { events } = await ask({ messages: [{ role: 'user', text: '早餐 18 咖啡 25' }] });
    const pendings = ofType(events, 'pending');
    expect(pendings.map((p) => p.changes.length)).toEqual([0, 1, 2]);
    expect(pendings[2]!.changes.map((c: any) => [c.expense.title, c.expense.amount, c.expense.payerId])).toEqual([
      ['早餐', 1800, ids.me],
      ['咖啡', 2500, ids.me],
    ]);
    expect(ofType(events, 'text').map((e) => e.delta).join('')).toBe('两笔都拟好了，确认后记入。');
    expect(ofType(events, 'step').map((e) => `${e.id}:${e.status}`)).toEqual(['call_a:start', 'call_a:done', 'call_b:start', 'call_b:done']);

    const second = requests[1]!.body.messages;
    expect(second.at(-3)).toMatchObject({ role: 'assistant', reasoning_content: '两笔', tool_calls: [{ id: 'call_a' }, { id: 'call_b' }] });
    expect(second.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'call_a' });
    expect(JSON.parse(second.at(-1).content)).toMatchObject({ status: 'proposed' });
    expect(requests[0]!.headers.authorization).toBe('Bearer sk-site-key-0123456789');
  });

  it('sends unparseable tool arguments back as a tool error', async () => {
    const requests = stubDeepSeek([
      [dsCall(0, { id: 'c', name: 'add_member', args: '{"name": "Mia"' }), dsFinish('length')],
      [dsText('参数有误'), dsFinish('stop')],
    ]);
    const { ask } = await setup(env);
    const { events } = await ask({ messages: [{ role: 'user', text: '加 Mia' }] });
    expect(ofType(events, 'step').map((e) => e.status)).toEqual(['start', 'error']);
    expect(JSON.parse(requests[1]!.body.messages.at(-1).content)).toEqual({ error: 'The arguments were not valid JSON' });
  });

  it('streams image drafts from json mode', async () => {
    const json = JSON.stringify({ items: [{ title: '盒马', amount: 166.5, date: '2026-10-06', category: 'groceries' }, { title: '滴滴', amount: 48, date: null, category: 'transport' }] }, null, 2);
    const requests = stubDeepSeek([
      [dsThink('读图'), ...Array.from({ length: Math.ceil(json.length / 7) }, (_, i) => dsText(json.slice(i * 7, i * 7 + 7))), dsFinish('stop')],
      [dsText('两笔已列好。'), dsFinish('stop')],
    ]);
    const { ask } = await setup(env);
    const { events } = await ask({ images: [IMAGE], messages: [{ role: 'user', text: '' }] });
    expect(requests[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(requests[0]!.body.messages[1].content[0]).toEqual({ type: 'image_url', image_url: { url: IMAGE } });
    const drafts = ofType(events, 'draft');
    expect(drafts.length).toBeGreaterThan(2);
    expect(drafts.find((d) => d.key === 'd0' && d.fields.amount !== undefined)!.fields.amount).toBe(166.5);
    expect(ofType(events, 'pending').at(-1)!.changes.map((c: any) => c.expense.amount)).toEqual([16650, 4800]);
  });
});

describe('assistant on Claude and OpenAI-compatible providers', () => {
  const OWN = 'sk-own-key-0123456789abcdef';

  it('runs the tool loop on Claude and sends thinking back unchanged', async () => {
    const requests = stubClaude([
      [start, ...thinkingBlock(0, 'sig-1'), ...toolBlock(1, 'toolu_a', 'add_member', '{"name":"Mia"}'), ...claudeStop('tool_use')],
      [start, ...textBlock(0, '已拟好，', '确认后加入。'), ...claudeStop()],
    ]);
    const { ask } = await setup({ ASSISTANT_PROVIDER: 'claude', CLAUDE_API_KEY: 'sk-ant-site-0123456789' });
    const { events } = await ask({ messages: [{ role: 'user', text: '加个成员 Mia' }] });
    expect(ofType(events, 'pending').at(-1)!.changes.map((c: any) => c.member?.name)).toEqual(['Mia']);
    expect(ofType(events, 'text').map((e) => e.delta).join('')).toBe('已拟好，确认后加入。');
    expect(requests[0]!.headers.get('x-api-key')).toBe('sk-ant-site-0123456789');
    expect(requests[0]!.body.model).toBe('claude-haiku-5-5');
    expect(requests[1]!.body.messages.at(-2)).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'tool_use', id: 'toolu_a', name: 'add_member', input: { name: 'Mia' } },
      ],
    });
    expect(requests[1]!.body.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_a' });
  });

  it('checks a Claude key by looking the model up', async () => {
    const requests = stubClaude([Response.json({ id: 'claude-haiku-5-5', type: 'model' }), Response.json({ type: 'error', error: { type: 'not_found_error', message: 'model: nope' } }, { status: 404 })]);
    const { request } = await setup({});
    const own = { 'x-ai-provider': 'claude', 'x-ai-key': OWN };
    expect(await (await request('POST', '/ledger/assistant/key', undefined, own)).json()).toEqual({ provider: 'claude', model: 'claude-haiku-5-5' });
    expect(requests[0]).toMatchObject({ method: 'GET', url: 'https://api.anthropic.com/v1/models/claude-haiku-5-5' });
    const missing = await request('POST', '/ledger/assistant/key', undefined, { ...own, 'x-ai-model': 'nope' });
    expect(await missing.json()).toEqual({ error: '找不到这个模型' });
  });

  it('uses a public OpenAI-compatible base URL from the user and refuses private ones', async () => {
    const requests = stubDeepSeek([[dsText('好'), dsFinish('stop')]]);
    const { ask } = await setup({});
    const own = (baseUrl: string) => ({ 'x-ai-provider': 'openai', 'x-ai-key': OWN, 'x-ai-model': 'Qwen/Qwen3-Max', 'x-ai-base-url': baseUrl });
    expect((await ask({}, 'zh-CN', own('https://llm.example.com/v1/'))).events.at(-1)).toEqual({ type: 'done' });
    expect(requests[0]!.url).toBe('https://llm.example.com/v1/chat/completions');
    for (const bad of ['http://llm.example.com/v1', 'https://192.168.1.2/v1', 'https://localhost:8000/v1']) {
      const { res, raw } = await ask({}, 'zh-CN', own(bad));
      expect(res.status).toBe(400);
      expect(JSON.parse(raw)).toEqual({ error: '服务地址需为公网 https 地址' });
    }
    expect((await ask({}, 'zh-CN', { 'x-ai-provider': 'openai', 'x-ai-key': OWN, 'x-ai-base-url': 'https://llm.example.com/v1' })).res.status).toBe(400);
    expect(requests).toHaveLength(1);
  });

  it('runs the site on an OpenAI-compatible server and validates its config', async () => {
    const requests = stubDeepSeek([[dsText('好'), dsFinish('stop')]]);
    const { ask } = await setup({ ASSISTANT_PROVIDER: 'openai', OPENAI_BASE_URL: 'http://ollama.lan:11434/v1', OPENAI_MODEL: 'qwen3:8b', OPENAI_API_KEY: 'ollama-key' });
    await ask({});
    expect(requests[0]!.url).toBe('http://ollama.lan:11434/v1/chat/completions');
    expect(requests[0]!.body.model).toBe('qwen3:8b');
    expect(() => loadConfig({ ASSISTANT_PROVIDER: 'openai', OPENAI_MODEL: 'x' })).toThrow('OPENAI_BASE_URL');
    expect(() => loadConfig({ OPENAI_BASE_URL: 'not a url' })).toThrow('OPENAI_BASE_URL');
  });
});
