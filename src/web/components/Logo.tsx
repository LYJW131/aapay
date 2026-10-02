import { useId } from 'react';
import { cn } from '../lib/cn.ts';

/** 品牌标识：一枚被均分、向两侧滑开的硬币 —— AA 分账 */
export function LogoMark({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden>
      <defs>
        <linearGradient id={`${id}a`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7C6CFF" />
          <stop offset="1" stopColor="#5B5CF0" />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3DD9EB" />
          <stop offset="1" stopColor="#16B3C9" />
        </linearGradient>
      </defs>
      <g transform="rotate(-40 256 256)">
        <path d="M242 102a154 154 0 0 0 0 308z" fill={`url(#${id}a)`} transform="translate(0 -14)" />
        <path d="M270 102a154 154 0 0 1 0 308z" fill={`url(#${id}b)`} transform="translate(0 14)" />
      </g>
    </svg>
  );
}

export function AppIcon({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden>
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5B5CF0" />
          <stop offset="1" stopColor="#16B3C9" />
        </linearGradient>
        <linearGradient id={`${id}h`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".78" />
          <stop offset="1" stopColor="#fff" stopOpacity=".38" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="128" fill={`url(#${id}bg)`} />
      <g transform="rotate(-40 256 256)">
        <path d="M242 102a154 154 0 0 0 0 308z" fill="#fff" transform="translate(0 -14)" />
        <path d="M270 102a154 154 0 0 1 0 308z" fill={`url(#${id}h)`} transform="translate(0 14)" />
      </g>
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <LogoMark className="size-[1.35em]" />
      <span>
        <span className="bg-gradient-to-br from-brand-500 to-accent-500 bg-clip-text text-transparent">AA</span>
        Pay
      </span>
    </span>
  );
}
