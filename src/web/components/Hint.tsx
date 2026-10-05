import { CircleHelp } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { common } from '../i18n/common.ts';
import { cn } from '../lib/cn.ts';

const GAP = 6;
const MARGIN = 12;
const WIDTH = 280;

export function Hint({ children, label = common.details, className }: { children: ReactNode; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !button.current || !popover.current) return setPos(null);
    const anchor = button.current.getBoundingClientRect();
    const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2);
    const height = popover.current.offsetHeight;
    const left = Math.min(Math.max(anchor.left + anchor.width / 2 - width / 2, MARGIN), window.innerWidth - MARGIN - width);
    const below = anchor.bottom + GAP + height <= window.innerHeight - MARGIN;
    setPos({ left, width, top: below ? anchor.bottom + GAP : anchor.top - GAP - height });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!button.current?.contains(target) && !popover.current?.contains(target)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const hover = (next: boolean) => (e: ReactPointerEvent) => e.pointerType === 'mouse' && setOpen(next);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onPointerEnter={hover(true)}
        onPointerLeave={hover(false)}
        className={cn('inline-flex shrink-0 align-[-2px] opacity-50 transition hover:opacity-90 aria-expanded:opacity-90', className)}
      >
        <CircleHelp className="size-3.5" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popover}
            role="tooltip"
            style={pos ?? { left: 0, top: 0, width: Math.min(WIDTH, window.innerWidth - MARGIN * 2), visibility: 'hidden' }}
            className="fixed z-[60] rounded-2xl bg-zinc-900 px-3.5 py-2.5 text-left text-[13px] leading-relaxed font-normal text-zinc-100 shadow-xl dark:bg-zinc-700"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
