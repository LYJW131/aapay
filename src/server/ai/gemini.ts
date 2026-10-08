import { ModelError, parseData, probe, sseStream, type ModelKey, type ModelOptions, type ModelRequest, type Part } from './model.ts';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: object };
}

interface GeminiChunk {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string };
}

const FAILED_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'OTHER']);

function toGemini(part: Part): GeminiPart | null {
  const signature = part.signature ? { thoughtSignature: part.signature } : {};
  if (part.call) return { functionCall: { ...(part.call.id && { id: part.call.id }), name: part.call.name, args: part.call.args ?? {} }, ...signature };
  if (part.result) return { functionResponse: { ...(part.result.id && { id: part.result.id }), name: part.result.name, response: part.result.response } };
  if (part.image) return { inlineData: part.image };
  if (part.text !== undefined || part.signature) return { text: part.text ?? '', ...(part.thought && { thought: true }), ...signature };
  return null;
}

function fromGemini(part: GeminiPart): Part {
  const signature = part.thoughtSignature ? { signature: part.thoughtSignature } : {};
  if (part.functionCall) {
    const { id, name, args } = part.functionCall;
    return { call: { ...(id && { id }), name, args: args ?? {} }, ...signature };
  }
  return { ...(part.text !== undefined && { text: part.text }), ...(part.thought && { thought: true }), ...signature };
}

function body(request: ModelRequest) {
  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: request.messages.map((m) => ({ role: m.role, parts: m.parts.flatMap((p) => toGemini(p) ?? []) })),
    ...(request.tools?.length && { tools: [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] }),
    ...(request.toolChoice === 'none' && { toolConfig: { functionCallingConfig: { mode: 'NONE' } } }),
    ...((request.json || request.temperature !== undefined) && {
      generationConfig: {
        ...(request.json && { responseMimeType: 'application/json', responseJsonSchema: request.json }),
        ...(request.temperature !== undefined && { temperature: request.temperature }),
      },
    }),
  };
}

function check(chunk: GeminiChunk) {
  if (chunk.error) throw new ModelError(chunk.error.code ?? 500, chunk.error.message ?? 'Gemini stream error');
  if (chunk.promptFeedback?.blockReason) throw new ModelError(400, `Prompt blocked: ${chunk.promptFeedback.blockReason}`);
  const reason = chunk.candidates?.[0]?.finishReason;
  if (reason && FAILED_FINISH.has(reason)) throw new ModelError(502, `Gemini finished with ${reason}`);
}

export async function* streamGemini(request: ModelRequest, options: ModelOptions): AsyncGenerator<Part[]> {
  const stream = sseStream(
    'Gemini',
    `${BASE}/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`,
    { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey }, body: JSON.stringify(body(request)) },
    options,
  );
  for await (const data of stream) {
    const chunk = parseData<GeminiChunk>('Gemini', data);
    check(chunk);
    const parts = chunk.candidates?.[0]?.content?.parts;
    if (parts?.length) yield parts.map(fromGemini);
  }
}

export async function checkGemini({ apiKey, model, idleTimeout }: ModelKey) {
  await probe('Gemini', `${BASE}/${encodeURIComponent(model)}`, idleTimeout, { headers: { 'x-goog-api-key': apiKey } });
}
