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
    expect(await (await setup()).json('GET', '/config')).toMatchObject({ assistant: { builtin: true, model: 'gemini-flash-lite-latest' } });
  });
});

describe('bring your own Gemini key', () => {
  const OWN = 'AQ.own-key-0123456789abcdef';

  it('uses the key and model from the request headers over the built-in ones', async () => {
    const requests = stubGemini([[text('好')]]);
    const { ask } = await setup();
    const { events } = await ask({}, 'zh-CN', { 'x-gemini-key': OWN, 'x-gemini-model': 'gemini-9-pro' });
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(requests[0]!.headers['x-goog-api-key']).toBe(OWN);
    expect(requests[0]!.url).toContain('/models/gemini-9-pro:streamGenerateContent');
  });

  it('ignores the model header without an own key', async () => {
    const requests = stubGemini([[text('好')]]);
    const { ask } = await setup();
    await ask({}, 'zh-CN', { 'x-gemini-model': 'gemini-9-pro' });
    expect(requests[0]!.headers['x-goog-api-key']).toBe('test-key');
    expect(requests[0]!.url).toContain('/models/gemini-flash-lite-latest:');
  });

  it('asks for a key when the server has none', async () => {
    stubGemini([]);
    const { ask, json } = await setup({});
    expect((await json('GET', '/config')).assistant).toEqual({ builtin: false, model: 'gemini-flash-lite-latest' });
    const { res, raw } = await ask({});
    expect(res.status).toBe(400);
    expect(JSON.parse(raw)).toEqual({ error: '请先填写你的 Gemini API Key' });
  });

  it('turns the assistant off entirely with ASSISTANT=disabled', async () => {
    const { ask, json } = await setup({ ASSISTANT: 'disabled', GEMINI_API_KEY: 'test-key' });
    expect((await json('GET', '/config')).assistant).toBeNull();
    expect((await ask({}, 'zh-CN', { 'x-gemini-key': OWN })).res.status).toBe(404);
  });

  it('rejects malformed keys and models before calling Gemini', async () => {
    const requests = stubGemini([]);
    const { ask } = await setup({});
    expect((await ask({}, 'zh-CN', { 'x-gemini-key': 'short' })).res.status).toBe(400);
    expect((await ask({}, 'zh-CN', { 'x-gemini-key': OWN, 'x-gemini-model': '../files' })).res.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('reports upstream key problems in terms of the user key', async () => {
    stubGemini([
      new Response(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }), { status: 400 }),
      new Response('{}', { status: 429 }),
    ]);
    const { ask } = await setup({});
    expect((await ask({}, 'zh-CN', { 'x-gemini-key': OWN })).events.at(-1)).toEqual({ type: 'error', message: 'Gemini API Key 无效' });
    expect((await ask({}, 'zh-CN', { 'x-gemini-key': OWN })).events.at(-1)).toEqual({ type: 'error', message: '你的 Gemini API Key 额度已用完或请求太频繁' });
  });

  it('checks a key against the chosen model without generating anything', async () => {
    const requests = stubGemini([new Response('{}'), new Response('{}', { status: 404 })]);
    const { request } = await setup({});
    const ok = await request('POST', '/ledger/assistant/key', undefined, { 'x-gemini-key': OWN });
    expect(await ok.json()).toEqual({ model: 'gemini-flash-lite-latest' });
    expect(requests[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest');
    expect(requests[0]!.headers['x-goog-api-key']).toBe(OWN);
    const missing = await request('POST', '/ledger/assistant/key', undefined, { 'x-gemini-key': OWN, 'x-gemini-model': 'gemini-nope' });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: '找不到这个 Gemini 模型' });
    expect((await request('POST', '/ledger/assistant/key')).status).toBe(400);
  });

  it('reports a key check that times out as 504', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const { request } = await setup({});
    const res = await request('POST', '/ledger/assistant/key', undefined, { 'x-gemini-key': OWN });
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: 'AI 助手响应超时，请重试' });
  });
});
