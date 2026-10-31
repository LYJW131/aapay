import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { messages } from '../web/i18n/locale.ts';
import { REPO_URL } from '../web/lib/version.ts';

const t = messages({
  'zh-CN': { notice: '演示站：数据只存在这个浏览器里', reset: '重置', deploy: '部署自己的' },
  en: { notice: 'Demo: data stays in this browser', reset: 'Reset', deploy: 'Deploy your own' },
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
