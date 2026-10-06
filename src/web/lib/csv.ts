type Cell = string | number;

function cell(value: Cell) {
  let text = String(value);
  // 以 = + - @ 开头的文本会被 Excel 当成公式执行
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export const toCsv = (rows: readonly (readonly Cell[])[]) => rows.map((r) => r.map(cell).join(',')).join('\r\n');

export function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob(['﻿', text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[\\/:*?"<>|]+/g, '_');
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
