import { AnimatePresence, motion, PresenceContext, useIsPresent, type MotionProps } from 'motion/react';
import { useContext, useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

// 用 clip-path 只裁纵向，不用 overflow：hidden 会让它成为滚动容器，里面 sticky 的日期标题会改为相对它定位而错位；
// overflow-y: clip 在 Safari 的合成层里会连横向一起裁（WebKit bug 271457），动画结束后仍切掉两侧的焦点环和阴影
export const CLIP_Y = 'inset(0 -100vmax)';

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
  const entering = useContext(PresenceContext)?.initial !== false;
  const node = useRef<HTMLElement | null>(null);
  // 只在过渡中纵向裁切，停住后再裁会切掉阴影和焦点环。按动画中的高度值开关、直接写 DOM 而不走 state：
  // 动画开始时重新渲染会打乱 motion 测量高度时对滚动位置的保存与恢复；
  // transitionEnd 或在完成回调里改 motion 值，motion 都不会重新渲染，样式会一直停在裁切。
  const clip = (on: boolean) => {
    if (node.current) node.current.style.clipPath = on ? CLIP_Y : '';
  };
  useLayoutEffect(() => clip(entering), []);
  // 收起时直接给出起点高度：只写 height: 0 的话 motion 会先把元素设成 0 去量 auto 的起点，
  // 量的那一刻页面瞬间变短，滚动位置被钳住且恢复不回来（搜索时一次收起很多块尤其明显）
  const from = !present && node.current ? parseFloat(getComputedStyle(node.current).height) : null;
  const Element = motion[as];
  return (
    <Element
      ref={(el: HTMLElement | null) => {
        node.current = el;
      }}
      layout={layout}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: from === null ? 0 : [from, 0], opacity: 0 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      onUpdate={(latest) => clip(typeof latest.height === 'number')}
      onAnimationComplete={() => present && clip(false)}
    >
      {/* flow-root 挡住子元素外边距穿透：否则裁切与否（是否成为 BFC）会让高度差出一截，动画首尾跳一下 */}
      <div className={cn('flow-root', className)}>{children}</div>
    </Element>
  );
}
