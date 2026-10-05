import { X } from 'lucide-react';
import { AnimatePresence, motion, useDragControls } from 'motion/react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn.ts';
import { useMediaQuery } from '../lib/hooks.ts';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

// offsetTop 以面板（relative）为基准且不受滚动影响，el 与面板之间不能再有定位元素
export function roomInSheet(el: HTMLElement) {
  const panel = el.closest<HTMLElement>('[role=dialog]')!;
  return parseFloat(getComputedStyle(panel).maxHeight) - el.offsetTop + panel.lastElementChild!.scrollTop;
}

export function Sheet({ open, onClose, title, description, children, className }: SheetProps) {
  const desktop = useMediaQuery('(min-width: 640px)');
  const drag = useDragControls();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!open) return setEntered(false);
    // 挂载这一帧要排版整个表单，手机上会卡几十毫秒；动画若从这一帧开始计时，第一次画出来时已滑到半路。
    // 先在屏幕外挂载，等这一帧画完（两层 rAF：第一层回调仍在该帧排版之前）再开始入场动画
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setEntered(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    // 焦点留在打开弹窗的按钮上，关闭后那个按钮会一直显示焦点框
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const hidden = desktop ? { opacity: 0, scale: 0.96, y: 12 } : { y: '100%' };
  const shown = desktop ? { opacity: 1, scale: 1, y: 0 } : { y: 0 };

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
          <motion.div
            className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[3px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: entered ? 1 : 0 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className={cn(
              'relative flex max-h-[92dvh] w-full flex-col overflow-hidden outline-none rounded-t-[28px] bg-surface shadow-2xl ring-1 ring-zinc-900/5 sm:max-w-md sm:rounded-[28px] dark:ring-white/10',
              className,
            )}
            initial={hidden}
            animate={entered ? shown : hidden}
            exit={desktop ? { opacity: 0, scale: 0.97, y: 8 } : { y: '100%' }}
            transition={{ type: 'spring', damping: 34, stiffness: 420 }}
            drag={desktop ? false : 'y'}
            dragControls={drag}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.7 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 110 || info.velocity.y > 600) onClose();
            }}
          >
            <header
              className="shrink-0 touch-none px-5 pt-2.5 pb-3 sm:pt-5"
              onPointerDown={(e) => !desktop && drag.start(e)}
            >
              <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-zinc-300 sm:hidden dark:bg-zinc-700" />
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 id={titleId} className="text-lg font-semibold tracking-tight">
                    {title}
                  </h2>
                  {description && <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
                </div>
                <button
                  onClick={onClose}
                  className="-mr-1.5 rounded-full p-1.5 text-zinc-400 transition hover:bg-zinc-900/5 hover:text-zinc-600 dark:hover:bg-white/8"
                  aria-label="关闭"
                >
                  <X className="size-5" />
                </button>
              </div>
            </header>
            <div className="safe-bottom overflow-y-auto overscroll-contain px-5">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
