import { motion } from 'motion/react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export function AutoHeight({ children, className }: { children: ReactNode; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>('auto');
  const [animating, setAnimating] = useState(false);

  useLayoutEffect(() => {
    const el = inner.current!;
    let last: number | null = null;
    const observer = new ResizeObserver(() => {
      const next = el.offsetHeight;
      if (last !== null && last !== next) setAnimating(true);
      last = next;
      setHeight(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.div
      initial={false}
      animate={{ height }}
      // 首次测量直接定高：从 auto 过渡到同一个高度也会逐帧写 height，弹窗滑入时每帧都要重排重绘
      transition={animating ? { duration: 0.25, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
      onAnimationComplete={() => setAnimating(false)}
      className={className}
      // 只在高度真正变化的过渡中裁切（首次测量不算），避免切掉子元素的阴影和焦点环
      style={{ overflow: animating ? 'hidden' : 'visible' }}
    >
      <div ref={inner} className="flow-root">
        {children}
      </div>
    </motion.div>
  );
}
