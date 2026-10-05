import { AnimatePresence, motion, PresenceContext, useIsPresent, type MotionProps } from 'motion/react';
import { useContext, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <AnimatePresence initial={false}>
      {open && <Reveal className={className}>{children}</Reveal>}
    </AnimatePresence>
  );
}

// 增删时高度在 0 与 auto 之间过渡。间距要放在 className（内层的 padding）里：
// 外层若用 space-y / margin 隔开，外边距不参与动画，会在动画开始或结束时瞬间出现、消失
export function Reveal({
  as = 'div',
  layout,
  children,
  className,
}: {
  as?: 'div' | 'li' | 'section';
  layout?: MotionProps['layout'];
  children: ReactNode;
  className?: string;
}) {
  const present = useIsPresent();
  // 随 AnimatePresence 首次渲染出现的元素不播放进入动画，不需要裁切
  const [clip, setClip] = useState(useContext(PresenceContext)?.initial !== false);
  const Element = motion[as];
  return (
    <Element
      layout={layout}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      onAnimationStart={() => setClip(true)}
      onAnimationComplete={() => present && setClip(false)}
      // 只在过渡中裁切，停住后再裁会切掉阴影和焦点环；不能用 transitionEnd 恢复：motion 在高度动画结束后改了值却不重新渲染。
      // 用 clip 而不是 hidden：hidden 会让它成为滚动容器，里面 sticky 的日期标题会改为相对它定位而错位，聚焦输入框也会把它滚走
      className={clip ? 'overflow-clip' : undefined}
    >
      {/* flow-root 挡住子元素外边距穿透：否则裁切与否（是否成为 BFC）会让高度差出一截，动画首尾跳一下 */}
      <div className={cn('flow-root', className)}>{children}</div>
    </Element>
  );
}
