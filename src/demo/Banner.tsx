import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { messages } from '../web/i18n/locale.ts';
import { REPO_URL } from '../web/lib/version.ts';

const t = messages({
  'zh-CN': { notice: '演示站：数据只存在这个浏览器里', reset: '重置', deploy: '部署自己的', elsewhere: '演示站已在另一个标签页打开', resume: '在这里继续' },
  en: { notice: 'Demo: data stays in this browser', reset: 'Reset', deploy: 'Deploy your own', elsewhere: 'The demo is open in another tab', resume: 'Use it here' },
});

function Banner({ onReset }: { onReset: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center justify-center gap-3 bg-zinc-900 px-4 py-1.5 text-xs text-zinc-300 dark:bg-zinc-800/60">
      <span className="truncate">{t.notice}</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onReset();
        }}
        className="inline-flex shrink-0 items-center gap-1 font-medium text-white hover:underline disabled:opacity-60"
      >
        <RotateCcw className="size-3" />
        {t.reset}
      </button>
      <a href={`${REPO_URL}#readme`} className="shrink-0 font-medium text-white hover:underline">
        {t.deploy}
      </a>
    </div>
  );
}

export function mountBanner(onReset: () => Promise<void>) {
  const host = document.createElement('div');
  host.id = 'demo-banner';
  document.body.prepend(host);
  createRoot(host).render(<Banner onReset={onReset} />);
}

export function mountTakenOver() {
  const host = document.createElement('div');
  host.className = 'fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-canvas/90 px-6 text-center backdrop-blur-sm';
  document.body.append(host);
  createRoot(host).render(
    <>
      <p className="text-sm text-zinc-600 dark:text-zinc-300">{t.elsewhere}</p>
      <button type="button" onClick={() => window.location.reload()} className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500">
        {t.resume}
      </button>
    </>,
  );
}
