import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

// max：外层有高度上限时（如弹窗）只在露出的范围内过渡。否则内容很高时头一帧就顶到上限，过渡全花在看不见的地方
export function AutoHeight({ children, className, max }: { children: ReactNode; className?: string; max?: (el: HTMLElement) => number }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = outer.current!;
    let last: number | null = null;
    let running: Animation | null = null;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry!.contentRect.height;
      if (last !== null && next !== last) {
        const room = max?.(el) ?? Infinity;
        const from = Math.min(parseFloat(getComputedStyle(el).height), room);
        const to = Math.min(next, room);
        running?.cancel();
        running = null;
        // 只在过渡中纵向裁切，静止时裁切会切掉阴影和焦点环；clip 不像 hidden 会成为滚动容器
        el.style.overflowY = from === to ? '' : 'clip';
        if (from !== to) {
          running = el.animate({ height: [`${from}px`, `${to}px`] }, { duration: 250, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
          running.onfinish = () => {
            el.style.overflowY = '';
            running = null;
          };
        }
      }
      // 静止时也写死高度：若是 auto，内容一变矮，排版时外层的滚动位置就被钳住了，等不到这里开始过渡
      el.style.height = `${next}px`;
      last = next;
    });
    observer.observe(inner.current!);
    return () => {
      observer.disconnect();
      running?.cancel();
    };
  }, []);

  return (
    // 写入的高度只算内容，padding（如给阴影和焦点环留余量的 -m-1 p-1）要加在外面，否则和内容差一截
    <div ref={outer} className={cn('box-content', className)}>
      <div ref={inner} className="flow-root">
        {children}
      </div>
    </div>
  );
}
