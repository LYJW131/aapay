import { ArrowUp, ImagePlus, Mic, Square, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type RefObject } from 'react';
import { toast } from 'sonner';
import { LIMITS } from '../../../shared/limits.ts';
import { assistant as t } from '../../i18n/assistant.ts';
import { cn } from '../../lib/cn.ts';
import { compressImage } from '../../lib/image.ts';
import { speechSupported, useSpeech } from './speech.ts';

const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform);
const MAX_HEIGHT = 5 * 24 + 20;

export function Composer({
  input,
  open,
  text,
  onText,
  images,
  onImages,
  streaming,
  onSend,
  onStop,
  onFocus,
}: {
  input: RefObject<HTMLTextAreaElement | null>;
  open: boolean;
  text: string;
  onText: (text: string) => void;
  images: string[];
  onImages: (images: string[]) => void;
  streaming: boolean;
  onSend: () => void;
  onStop: () => void;
  onFocus: () => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [tip, setTip] = useState(0);
  const speech = useSpeech(onText);
  const canSend = !streaming && (text.trim().length > 0 || images.length > 0);
  const send = () => {
    speech.cancel();
    onSend();
  };

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, open ? MAX_HEIGHT : 44)}px`;
  }, [text, open, input]);

  useEffect(() => {
    if (open || text) return;
    const id = setInterval(() => setTip((i) => (i + 1) % t.placeholders.length), 3600);
    return () => clearInterval(id);
  }, [open, text]);

  async function addFiles(files: File[]) {
    const room = LIMITS.assistantImages - images.length;
    const picked = files.filter((f) => f.type.startsWith('image/'));
    if (picked.length === 0) return;
    if (picked.length > room) toast(t.tooManyImages(LIMITS.assistantImages));
    const results = await Promise.allSettled(picked.slice(0, Math.max(0, room)).map((f) => compressImage(f)));
    const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (ok.length < results.length) toast.error(t.unreadableImage);
    if (ok.length) onImages([...images, ...ok].slice(0, LIMITS.assistantImages));
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (canSend) send();
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  }

  const toggleVoice = () => {
    if (speech.listening) return speech.stop();
    speech.start(text ? `${text.trimEnd()} ` : '');
    onFocus();
  };

  const iconButton =
    'flex size-9 shrink-0 items-center justify-center rounded-full text-zinc-500 transition hover:bg-zinc-900/6 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100';

  return (
    <div className="relative">
      <AnimatePresence initial={false}>
        {images.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="flex gap-2 overflow-x-auto px-3 pt-3 [scrollbar-width:none]">
              <AnimatePresence initial={false}>
                {images.map((src, i) => (
                  <motion.div
                    key={src.slice(-32) + i}
                    layout
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.6, opacity: 0 }}
                    className="relative shrink-0"
                  >
                    <img src={src} alt="" className="size-14 rounded-xl object-cover ring-1 ring-zinc-900/8 dark:ring-white/10" />
                    <button
                      type="button"
                      aria-label={t.removeImage}
                      onClick={() => onImages(images.filter((_, j) => j !== i))}
                      className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-zinc-900 text-white shadow ring-2 ring-surface dark:bg-zinc-600"
                    >
                      <X className="size-3" strokeWidth={3} />
                    </button>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex items-end gap-1 py-1.5 pr-1.5 pl-4">
        <div className="relative min-w-0 flex-1 self-center">
          <textarea
            ref={input}
            value={text}
            rows={1}
            onChange={(e) => onText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={onFocus}
            enterKeyHint="send"
            aria-label={t.ask}
            placeholder={open ? (speech.listening ? t.listening : t.placeholderOpen) : ''}
            className="block max-h-[140px] w-full resize-none bg-transparent py-2 text-[15px] leading-6 text-zinc-900 outline-none placeholder:text-zinc-400 pointer-coarse:text-base dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
          {!open && !text && (
            <span className="pointer-events-none absolute inset-0 flex items-center overflow-hidden text-[15px] text-zinc-400 pointer-coarse:text-base dark:text-zinc-500" aria-hidden>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={tip}
                  initial={{ y: 14, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -14, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                  className="block min-w-0 truncate"
                >
                  {t.placeholders[tip]}
                </motion.span>
              </AnimatePresence>
            </span>
          )}
        </div>
        {!open && !text && (
          <kbd className="mr-1 mb-2.5 hidden h-5 items-center rounded-md px-1.5 font-sans text-[11px] font-medium text-zinc-400 ring-1 ring-zinc-900/10 lg:flex dark:ring-white/12">
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        )}
        <input
          ref={file}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            void addFiles(files);
          }}
        />
        <button type="button" aria-label={t.attach} title={t.attach} onClick={() => file.current?.click()} className={iconButton}>
          <ImagePlus className="size-[18px]" />
        </button>
        {speechSupported && (
          <button
            type="button"
            aria-label={speech.listening ? t.stopVoice : t.voice}
            aria-pressed={speech.listening}
            title={speech.listening ? t.stopVoice : t.voice}
            onClick={toggleVoice}
            className={cn(iconButton, !open && 'hidden lg:flex', speech.listening && 'ai-listening bg-rose-500/12 text-rose-600 hover:bg-rose-500/15 hover:text-rose-600 dark:text-rose-300')}
          >
            <Mic className="size-[18px]" />
          </button>
        )}
        <AnimatePresence mode="popLayout" initial={false}>
          {streaming ? (
            <motion.button
              key="stop"
              type="button"
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.6, opacity: 0 }}
              aria-label={t.stop}
              title={t.stop}
              onClick={onStop}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              <Square className="size-3.5" fill="currentColor" />
            </motion.button>
          ) : (
            <motion.button
              key="send"
              type="button"
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.6, opacity: 0 }}
              aria-label={t.send}
              title={t.send}
              disabled={!canSend}
              onClick={send}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-accent-500 text-white shadow-[0_4px_12px_-4px] shadow-brand-500/70 transition hover:brightness-110 disabled:from-zinc-300 disabled:to-zinc-300 disabled:shadow-none dark:disabled:from-white/12 dark:disabled:to-white/12 dark:disabled:text-zinc-500"
            >
              <ArrowUp className="size-[18px]" strokeWidth={2.5} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
