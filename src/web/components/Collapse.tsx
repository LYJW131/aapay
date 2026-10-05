import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <AnimatePresence initial={false}>
      {open && (
        <Body clipped={mounted} className={className}>
          {children}
        </Body>
      )}
    </AnimatePresence>
  );
}

function Body({ clipped, children, className }: { clipped: boolean; children: ReactNode; className?: string }) {
  const present = useIsPresent();
  const [clip, setClip] = useState(clipped);
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      onAnimationStart={() => setClip(true)}
      onAnimationComplete={() => present && setClip(false)}
      // 只在展开收起的过程中裁切：停住后仍 overflow-hidden 会切掉阴影和焦点环，还会让里面的 sticky 失效。
      // 不能用 transitionEnd 恢复：motion 在高度动画结束后改了值却不重新渲染，样式会一直停在 hidden
      className={clip ? 'overflow-hidden' : undefined}
    >
      {/* flow-root 挡住子元素外边距穿透：否则裁切与否（是否成为 BFC）会让高度差出一截，动画首尾跳一下 */}
      <div className={cn('flow-root', className)}>{children}</div>
    </motion.div>
  );
}
