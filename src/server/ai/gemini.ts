export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: GeminiFunctionCall;
  functionResponse?: { id?: string; name: string; response: object };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parametersJsonSchema: object;
}

export interface GeminiRequest {
  systemInstruction?: { parts: { text: string }[] };
  contents: GeminiContent[];
  tools?: { functionDeclarations: FunctionDeclaration[] }[];
  toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE' } };
  generationConfig?: Record<string, unknown>;
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  signal?: AbortSignal;
}

interface GeminiChunk {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string };
}

export class GeminiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

const FAILED_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'OTHER']);

function* parseEvents(buffer: { text: string }): Generator<GeminiChunk> {
  let end: number;
  while ((end = buffer.text.indexOf('\n\n')) >= 0) {
    const block = buffer.text.slice(0, end);
    buffer.text = buffer.text.slice(end + 2);
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data) yield JSON.parse(data) as GeminiChunk;
  }
}

function check(chunk: GeminiChunk) {
  if (chunk.error) throw new GeminiError(chunk.error.code ?? 500, chunk.error.message ?? 'Gemini stream error');
  if (chunk.promptFeedback?.blockReason) throw new GeminiError(400, `Prompt blocked: ${chunk.promptFeedback.blockReason}`);
  const reason = chunk.candidates?.[0]?.finishReason;
  if (reason && FAILED_FINISH.has(reason)) throw new GeminiError(502, `Gemini finished with ${reason}`);
}

export async function* streamGemini(request: GeminiRequest, { apiKey, model, signal }: GeminiOptions): AsyncGenerator<GeminiPart[]> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok || !res.body) throw new GeminiError(res.status, `Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const decoder = new TextDecoder();
  const buffer = { text: '' };
  let carry = '';
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      let text = carry + (done ? decoder.decode() + '\n\n' : decoder.decode(value, { stream: true }));
      carry = text.endsWith('\r') ? '\r' : '';
      if (carry) text = text.slice(0, -1);
      buffer.text += text.replace(/\r\n?/g, '\n');
      for (const chunk of parseEvents(buffer)) {
        check(chunk);
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (parts?.length) yield parts;
      }
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
