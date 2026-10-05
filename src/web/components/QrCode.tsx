import { useMemo } from 'react';
import { encode } from 'uqr';
import { common } from '../i18n/common.ts';

// 中间嵌入图标，所以用 H 级纠错
export function QrCode({ value, className }: { value: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const { data, size } = encode(value, { ecc: 'H', border: 0 });
    const finder = (x: number, y: number) =>
      (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);
    const hole = Math.ceil(size * 0.24);
    const start = Math.floor((size - hole) / 2);
    let d = '';
    data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (!on || finder(x, y)) return;
        if (x >= start && x < start + hole && y >= start && y < start + hole) return;
        d += `M${x + 0.5} ${y + 0.08}a.42 .42 0 1 1 0 .84a.42 .42 0 1 1 0-.84z`;
      }),
    );
    return { size, path: d };
  }, [value]);

  const eye = (x: number, y: number) => (
    <g key={`${x}-${y}`} transform={`translate(${x} ${y})`}>
      <rect x=".5" y=".5" width="6" height="6" rx="1.8" fill="none" stroke="currentColor" />
      <rect x="2" y="2" width="3" height="3" rx="1" fill="currentColor" />
    </g>
  );
  const iconSize = size * 0.2;

  return (
    <div className={className}>
      <svg viewBox={`-1 -1 ${size + 2} ${size + 2}`} className="size-full" role="img" aria-label={common.qrCode}>
        <path d={path} fill="currentColor" />
        {eye(0, 0)}
        {eye(size - 7, 0)}
        {eye(0, size - 7)}
        <image href="/favicon.svg" x={(size - iconSize) / 2} y={(size - iconSize) / 2} width={iconSize} height={iconSize} />
      </svg>
    </div>
  );
}
