import { createContext, use } from 'react';

export interface AssistantOpenOptions {
  text?: string;
  images?: string[];
  send?: boolean;
}

export interface AssistantApi {
  available: boolean;
  open(options?: AssistantOpenOptions): void;
}

export const AssistantContext = createContext<AssistantApi>({ available: false, open: () => undefined });

export const useAssistant = () => use(AssistantContext);
