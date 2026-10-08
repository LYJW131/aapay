import { checkDeepSeek, checkOpenAI, streamDeepSeek, streamOpenAI } from './chat.ts';
import { checkClaude, streamClaude } from './claude.ts';
import { checkGemini, streamGemini } from './gemini.ts';
import type { ModelKey, ModelOptions, ModelRequest, Part } from './model.ts';
import type { AiProvider } from '../../shared/assistant.ts';

const PROVIDERS: Record<AiProvider, { stream: (request: ModelRequest, options: ModelOptions) => AsyncGenerator<Part[]>; check: (key: ModelKey) => Promise<void> }> = {
  gemini: { stream: streamGemini, check: checkGemini },
  deepseek: { stream: streamDeepSeek, check: checkDeepSeek },
  claude: { stream: streamClaude, check: checkClaude },
  openai: { stream: streamOpenAI, check: checkOpenAI },
};

export const streamModel = (request: ModelRequest, options: ModelOptions) => PROVIDERS[options.provider].stream(request, options);

export const checkModel = (key: ModelKey) => PROVIDERS[key.provider].check(key);
