import { motion } from 'motion/react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

export function AutoHeight({ children, className }: { children: ReactNode; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>('auto');
  const [animating, setAnimating] = useState(false);

  useLayoutEffect(() => {
    let last: number | null = null;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry!.contentRect.height;
      if (last !== null && last !== next) setAnimating(true);
      last = next;
      setHeight(next);
    });
    observer.observe(inner.current!);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.div
      initial={false}
      animate={{ height }}
      // 首次测量直接定高：从 auto 过渡到同一个高度也会逐帧写 height，弹窗滑入时每帧都要重排重绘
      transition={animating ? { duration: 0.25, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
      onAnimationComplete={() => setAnimating(false)}
      // 定高只量内容，padding（如给阴影和焦点环留余量的 -m-1 p-1）要加在外面，否则定高后比 auto 时矮一截
      className={cn('box-content', className)}
      // 只在高度真正变化的过渡中裁切（首次测量不算），避免切掉子元素的阴影和焦点环
      style={{ overflow: animating ? 'hidden' : 'visible' }}
    >
      <div ref={inner} className="flow-root">
        {children}
      </div>
    </motion.div>
  );
}
