import { useCallback, useEffect, useRef, useState } from 'react';
import { locale } from '../../i18n/locale.ts';

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}

interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionConstructor = new () => Recognition;

const Speech = ((window as unknown as Record<string, unknown>).SpeechRecognition ??
  (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as RecognitionConstructor | undefined;

export const speechSupported = !!Speech;

export function useSpeech(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const callback = useRef(onText);
  callback.current = onText;

  const stop = useCallback(() => recognition.current?.stop(), []);

  const cancel = useCallback(() => {
    const r = recognition.current;
    if (!r) return;
    r.onresult = null;
    r.abort();
  }, []);

  const start = useCallback((prefix: string) => {
    if (!Speech || recognition.current) return;
    const r = new Speech();
    r.lang = locale;
    r.continuous = true;
    r.interimResults = true;
    let finals = '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]!;
        if (result.isFinal) finals += result[0].transcript;
        else interim += result[0].transcript;
      }
      callback.current(prefix + finals + interim);
    };
    r.onend = () => {
      recognition.current = null;
      setListening(false);
    };
    r.onerror = () => r.abort();
    recognition.current = r;
    setListening(true);
    try {
      r.start();
    } catch {
      recognition.current = null;
      setListening(false);
    }
  }, []);

  useEffect(() => () => recognition.current?.abort(), []);

  return { listening, start, stop, cancel };
}
