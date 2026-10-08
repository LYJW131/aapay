import { checkDeepSeek, streamDeepSeek } from './deepseek.ts';
import { checkGemini, streamGemini } from './gemini.ts';
import type { ModelKey, ModelOptions, ModelRequest, Part } from './model.ts';

export function streamModel(request: ModelRequest, options: ModelOptions): AsyncGenerator<Part[]> {
  return options.provider === 'deepseek' ? streamDeepSeek(request, options) : streamGemini(request, options);
}

export function checkModel(key: ModelKey): Promise<void> {
  return key.provider === 'deepseek' ? checkDeepSeek(key) : checkGemini(key);
}
