import { ChevronDown, KeyRound, Plus, Settings2, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { LIMITS } from '../../../shared/limits.ts';
import type { PublicConfig } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { Hint } from '../../components/Hint.tsx';
import { Switch } from '../../components/Switch.tsx';
import { assistant as t } from '../../i18n/assistant.ts';
import { ledger } from '../../i18n/ledger.ts';
import { cn } from '../../lib/cn.ts';
import { useMediaQuery } from '../../lib/hooks.ts';
import { useLedger } from '../ledger/context.tsx';
import { Composer } from './Composer.tsx';
import { AssistantContext, type AssistantApi, type AssistantOpenOptions } from './context.ts';
import { AiAvatar, Conversation } from './Conversation.tsx';
import { KeySheet } from './KeySheet.tsx';
import { PROVIDER_NAMES, useOwnKey } from './own-key.ts';
import { StoreContext, useChatState, useChatStore } from './state.ts';
import { AssistantStore, findPending } from './store.ts';

const UNAVAILABLE: AssistantApi = { available: false, open: () => undefined };
const SPRING = { type: 'spring', stiffness: 380, damping: 36 } as const;

export function AssistantDock({ config, onCompose, children }: { config: PublicConfig['assistant']; onCompose: () => void; children: ReactNode }) {
  return config ? (
    <Dock config={config} onCompose={onCompose}>
      {children}
    </Dock>
  ) : (
    <Fallback onCompose={onCompose}>{children}</Fallback>
  );
}

function Fallback({ onCompose, children }: { onCompose: () => void; children: ReactNode }) {
  const { snapshot } = useLedger();
  const desktop = useMediaQuery('(min-width: 1024px)');
  return (
    <AssistantContext value={UNAVAILABLE}>
      {children}
      <div aria-hidden className="h-[calc(5rem+env(safe-area-inset-bottom))] lg:h-4" />
      <AnimatePresence>
        {!desktop && snapshot.members.length > 0 && (
          <motion.button
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            whileTap={{ scale: 0.92 }}
            onClick={onCompose}
            className="fixed right-5 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-20 flex h-14 items-center gap-2 rounded-full bg-gradient-to-br from-brand-500 to-accent-500 pr-6 pl-5 font-semibold text-white shadow-[0_12px_32px_-8px] shadow-brand-500/70"
          >
            <Plus className="size-5" strokeWidth={2.5} />
            {ledger.page.addExpense}
          </motion.button>
        )}
      </AnimatePresence>
    </AssistantContext>
  );
}

function useKeyboardInset() {
  const read = () => {
    const vv = window.visualViewport;
    return vv ? { height: vv.height, inset: Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) } : { height: window.innerHeight, inset: 0 };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => setState(read());
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return state;
}

const editable = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);

const otherDialogOpen = () => !!document.querySelector('[role=dialog][aria-modal=true]:not([data-assistant])');

function Dock({ config, onCompose, children }: { config: NonNullable<PublicConfig['assistant']>; onCompose: () => void; children: ReactNode }) {
  const ledgerContext = useLedger();
  const own = useOwnKey();
  const needsKey = !config.builtin && !own;
  const [keyOpen, setKeyOpen] = useState(false);
  const [store] = useState(() => new AssistantStore({ ledger: ledgerContext.store, key: ledgerContext.key }));
  useEffect(() => () => store.dispose(), [store]);

  const desktop = useMediaQuery('(min-width: 1024px)');
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);
  const [composerHeight, setComposerHeight] = useState(52);
  const input = useRef<HTMLTextAreaElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const composerBox = useRef<HTMLDivElement>(null);
  const viewport = useKeyboardInset();
  const { streaming, messages } = useSyncExternalStore(store.subscribe, store.getState);
  const pendingCount = findPending(messages)?.set.changes.length ?? 0;

  useEffect(() => {
    const el = composerBox.current!;
    const observer = new ResizeObserver(([entry]) => setComposerHeight(Math.round(entry!.borderBoxSize[0]!.blockSize)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const focusInput = useCallback(() => {
    const el = input.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const show = useCallback(() => {
    setOpen(true);
    focusInput();
  }, [focusInput]);

  const hide = useCallback(() => {
    setOpen(false);
    setFocused(false);
    input.current?.blur();
    if (!desktop) store.revealChanges();
  }, [desktop, store]);

  const send = useCallback(
    (value: string, pics: string[]) => {
      if (store.getState().streaming) return;
      setOpen(true);
      if (needsKey) {
        setText(value);
        setImages(pics);
        return setKeyOpen(true);
      }
      setText('');
      setImages([]);
      void store.send(value, pics);
    },
    [store, needsKey],
  );

  const api = useMemo<AssistantApi>(
    () => ({
      available: true,
      open: ({ text: value, images: pics, send: now }: AssistantOpenOptions = {}) => {
        const list = (pics ?? []).slice(0, LIMITS.assistantImages);
        if (now && (value?.trim() || list.length) && !store.getState().streaming) return send(value ?? '', list);
        if (value !== undefined) setText(value);
        if (pics) setImages(list);
        show();
      },
    }),
    [store, send, show],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        if (otherDialogOpen()) return;
        e.preventDefault();
        if (open && document.activeElement === input.current) hide();
        else show();
      } else if (e.key === '/' && !mod && !e.altKey && !editable(document.activeElement) && !otherDialogOpen()) {
        e.preventDefault();
        show();
      } else if (e.key === 'Escape' && open && !otherDialogOpen()) {
        e.preventDefault();
        hide();
      } else if (mod && e.key === 'Enter' && open && !otherDialogOpen() && !store.getState().streaming && findPending(store.getState().messages)) {
        e.preventDefault();
        void store.apply();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, show, hide, store]);

  useEffect(() => {
    if (!open || desktop) return;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open, desktop]);

  const glowing = focused || streaming;
  const panelHeight = desktop
    ? `calc(min(72vh, 100vh - 4rem) - ${composerHeight}px)`
    : `calc(${viewport.height}px - ${composerHeight}px - env(safe-area-inset-top) - ${viewport.inset > 0 ? '1.25rem' : 'max(0.75rem, env(safe-area-inset-bottom)) - 0.75rem'})`;

  return (
    <AssistantContext value={api}>
      <StoreContext value={store}>
        {children}
        <div aria-hidden className="h-[calc(4rem+env(safe-area-inset-bottom))] lg:h-16" />

        <AnimatePresence>
          {open && !desktop && (
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={hide}
              className="fixed inset-0 z-40 bg-zinc-950/30 backdrop-blur-[2px]"
            />
          )}
        </AnimatePresence>

        <div
          className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex items-end justify-center gap-2 px-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:px-4 lg:pb-6"
          style={viewport.inset > 0 ? { bottom: viewport.inset, paddingBottom: '0.5rem' } : undefined}
        >
          <div
            ref={shell}
            data-assistant
            role={open ? 'dialog' : undefined}
            aria-label={open ? t.title : undefined}
            className="pointer-events-auto relative w-full max-w-[560px] min-w-0"
            onFocus={(e) => e.currentTarget.contains(e.target) && setFocused(true)}
            onBlur={(e) => e.currentTarget.contains(e.target) && !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
          >
            <AnimatePresence>
              {!open && pendingCount > 0 && (
                <motion.button
                  type="button"
                  initial={{ opacity: 0, y: 6, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 6, scale: 0.9 }}
                  transition={SPRING}
                  onClick={show}
                  className="absolute -top-3.5 left-5 z-20 flex h-6 items-center gap-1.5 rounded-full bg-amber-400 px-2.5 text-xs font-semibold text-amber-950 shadow-md"
                >
                  <span className="size-1.5 animate-pulse rounded-full bg-amber-950/70" />
                  {t.pendingBadge(pendingCount)}
                </motion.button>
              )}
            </AnimatePresence>
            <span aria-hidden className={cn('ai-halo pointer-events-none absolute -inset-12 opacity-0 transition-opacity duration-700', glowing && 'opacity-70 dark:opacity-55')}>
              <span className="ai-glow absolute inset-11 rounded-[30px] blur-[14px]" />
            </span>
            <span aria-hidden className={cn('ai-glow ai-ring pointer-events-none absolute -inset-[1.5px] z-10 rounded-[27.5px] opacity-0 transition-opacity duration-500', glowing && 'opacity-100')} />
            <div
              className={cn(
                'relative flex flex-col overflow-hidden rounded-[26px] bg-surface/85 ring-1 ring-zinc-900/8 backdrop-blur-2xl backdrop-saturate-150 transition-shadow duration-300 dark:bg-zinc-900/80 dark:ring-white/10',
                open
                  ? 'shadow-[0_24px_80px_-12px_rgb(0_0_0/0.35)]'
                  : 'shadow-[0_12px_40px_-12px_rgb(0_0_0/0.25),0_2px_6px_rgb(0_0_0/0.04)]',
              )}
            >
              <AnimatePresence initial={false}>
                {open && (
                  <motion.div
                    key="panel"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={SPRING}
                    className="overflow-hidden"
                  >
                    <div className="flex flex-col" style={{ height: panelHeight }}>
                      <PanelHeader onClose={hide} keyStatus={own ? t.key.own(PROVIDER_NAMES[own.provider]) : config.builtin ? t.key.site : t.key.none} onKey={() => setKeyOpen(true)} />
                      {needsKey && (
                        <div className="flex shrink-0 items-center gap-3 border-b border-zinc-900/6 bg-brand-500/6 py-2 pr-2 pl-4 text-[13px] text-zinc-600 dark:border-white/8 dark:bg-brand-400/8 dark:text-zinc-300">
                          <KeyRound className="size-4 shrink-0 text-brand-500" />
                          <span className="min-w-0 flex-1">{t.key.needed}</span>
                          <Button size="sm" variant="primary" onClick={() => setKeyOpen(true)}>
                            {t.key.fill}
                          </Button>
                        </div>
                      )}
                      <Conversation onSuggest={(s) => send(s, [])} onNavigate={() => !desktop && hide()} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              <div ref={composerBox} className={cn(open && 'border-t border-zinc-900/6 dark:border-white/8')}>
                <Composer
                  input={input}
                  open={open}
                  text={text}
                  onText={setText}
                  images={images}
                  onImages={setImages}
                  streaming={streaming}
                  onSend={() => send(text, images)}
                  onStop={() => store.stop()}
                  onFocus={() => setOpen(true)}
                />
              </div>
            </div>
          </div>
          <AnimatePresence initial={false}>
            {!desktop && !open && ledgerContext.snapshot.members.length > 0 && (
              <motion.button
                type="button"
                initial={{ scale: 0.5, opacity: 0, width: 0 }}
                animate={{ scale: 1, opacity: 1, width: 52 }}
                exit={{ scale: 0.5, opacity: 0, width: 0 }}
                transition={SPRING}
                whileTap={{ scale: 0.9 }}
                onClick={onCompose}
                aria-label={t.compose}
                title={t.compose}
                className="pointer-events-auto flex h-[52px] shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-accent-500 text-white shadow-[0_12px_32px_-8px] shadow-brand-500/70"
              >
                <Plus className="size-6" strokeWidth={2.5} />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
        <KeySheet open={keyOpen} onClose={() => setKeyOpen(false)} config={config} />
      </StoreContext>
    </AssistantContext>
  );
}

function PanelHeader({ onClose, keyStatus, onKey }: { onClose: () => void; keyStatus: string; onKey: () => void }) {
  return (
    <header className="flex shrink-0 items-center gap-2.5 border-b border-zinc-900/6 py-2.5 pr-2 pl-4 dark:border-white/8">
      <AiAvatar />
      <h2 className="flex-1 text-[15px] font-semibold tracking-tight">{t.title}</h2>
      <SettingsMenu keyStatus={keyStatus} onKey={onKey} />
      <button
        type="button"
        onClick={onClose}
        aria-label={t.close}
        title={t.close}
        className="flex size-9 items-center justify-center rounded-full text-zinc-500 transition hover:bg-zinc-900/6 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100"
      >
        <ChevronDown className="size-5" />
      </button>
    </header>
  );
}

function SettingsMenu({ keyStatus, onKey }: { keyStatus: string; onKey: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const store = useChatStore();
  const { autoRun, messages } = useChatState();

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={t.settings}
        aria-expanded={open}
        title={t.settings}
        onClick={() => setOpen(!open)}
        className="flex size-9 items-center justify-center rounded-full text-zinc-500 transition hover:bg-zinc-900/6 hover:text-zinc-800 aria-expanded:bg-zinc-900/6 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100 dark:aria-expanded:bg-white/10"
      >
        <Settings2 className="size-[18px]" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute top-full right-0 z-20 mt-1 w-64 origin-top-right rounded-2xl bg-surface p-1.5 shadow-xl ring-1 ring-zinc-900/8 dark:ring-white/10"
          >
            <div className="flex items-center gap-3 rounded-xl px-2.5 py-2 text-sm">
              <span className="flex flex-1 items-center gap-1.5">
                {t.autoRun}
                <Hint>{t.autoRunHint}</Hint>
              </span>
              <Switch checked={autoRun} onChange={(v) => store.setAutoRun(v)} label={t.autoRun} />
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onKey();
              }}
              className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm transition hover:bg-zinc-900/5 dark:hover:bg-white/8"
            >
              <KeyRound className="size-4 text-zinc-500 dark:text-zinc-400" />
              <span className="flex-1">{t.key.menu}</span>
              <span className="text-[13px] text-zinc-400">{keyStatus}</span>
            </button>
            <button
              type="button"
              disabled={messages.length === 0}
              onClick={() => {
                store.clear();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm text-rose-600 transition hover:bg-rose-500/8 disabled:opacity-40 dark:text-rose-400"
            >
              <Trash2 className="size-4" />
              {t.clear}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
