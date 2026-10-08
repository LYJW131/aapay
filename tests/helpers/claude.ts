import { vi } from 'vitest';
import { bytes } from './deepseek.ts';

export type ClaudeEvent = { type: string; [key: string]: unknown };

export const start: ClaudeEvent = {
  type: 'message_start',
  message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-5-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
};
export const ping: ClaudeEvent = { type: 'ping' };
export const blockStart = (index: number, block: Record<string, unknown>): ClaudeEvent => ({ type: 'content_block_start', index, content_block: block });
export const delta = (index: number, d: Record<string, unknown>): ClaudeEvent => ({ type: 'content_block_delta', index, delta: d });
export const blockStop = (index: number): ClaudeEvent => ({ type: 'content_block_stop', index });
export const stop = (stop_reason = 'end_turn'): ClaudeEvent[] => [
  { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
];
export const textBlock = (index: number, ...pieces: string[]): ClaudeEvent[] => [
  blockStart(index, { type: 'text', text: '' }),
  ...pieces.map((text) => delta(index, { type: 'text_delta', text })),
  blockStop(index),
];
export const toolBlock = (index: number, id: string, name: string, ...json: string[]): ClaudeEvent[] => [
  blockStart(index, { type: 'tool_use', id, name, input: {} }),
  ...json.map((partial_json) => delta(index, { type: 'input_json_delta', partial_json })),
  blockStop(index),
];
export const thinkingBlock = (index: number, signature: string): ClaudeEvent[] => [
  blockStart(index, { type: 'thinking', thinking: '', signature: '' }),
  delta(index, { type: 'signature_delta', signature }),
  blockStop(index),
];

export const claudeRaw = (events: ClaudeEvent[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

export type ClaudeReply = ClaudeEvent[] | Response;

export function stubClaude(replies: ClaudeReply[]) {
  const requests: { url: string; method: string; headers: Headers; body: any }[] = [];
  vi.stubGlobal('fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    const index = requests.length;
    requests.push({ url: String(url), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body as string) : null });
    const reply = replies[index];
    if (!reply) throw new Error(`unexpected Claude request #${index}`);
    if (reply instanceof Response) return reply;
    return new Response(bytes(claudeRaw(reply), 7), { headers: { 'content-type': 'text/event-stream' } });
  });
  return requests;
}
