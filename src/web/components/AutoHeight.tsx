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
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
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
