import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [base = 'http://127.0.0.1:5176', out = 'dist/demo/shots'] = process.argv.slice(2);
const NOW = new Date('2026-10-05T20:30:00+08:00');
const OWN_KEY = { provider: 'gemini', key: 'screenshot-placeholder-key', model: null, baseUrl: null };

const TEXT = {
  'zh-CN': {
    posixLocale: 'zh_CN',
    expenses: '昨天晚饭火锅 328 我付的，四人平分。再记一笔今天打车 45 老王付的，他和我两个人分',
    expensesReply: '这两笔已经准备好了，确认后记入。',
    me: '阿杰',
    wang: '老王',
    hotpot: '火锅',
    taxi: '打车',
    chart: '国庆这几天按分类看看花在哪了',
    chartReply: '住宿和餐饮占了六成，交通排第三。',
    pending: '确认执行',
  },
  en: {
    posixLocale: 'en_US',
    expenses: 'Hot pot last night, 328, I paid, split four ways. Also a taxi today, 45, Wang paid, split between him and me',
    expensesReply: 'Both are ready. Confirm to record them.',
    me: 'Jay',
    wang: 'Wang',
    hotpot: 'Hot pot',
    taxi: 'Taxi',
    chart: 'Where did the money go this week, by category?',
    chartReply: 'Lodging and food make up about 60%, transport comes third.',
    pending: 'Confirm',
  },
};

function geminiReply(scenario, text, body) {
  const followUp = JSON.stringify(body).includes('functionResponse');
  const parts = followUp
    ? [{ text: scenario === 'expenses' ? text.expensesReply : text.chartReply }]
    : scenario === 'expenses'
      ? [
          { functionCall: { name: 'add_expense', args: { title: text.hotpot, amount: 328, payer: text.me, date: '2026-10-04' } } },
          { functionCall: { name: 'add_expense', args: { title: text.taxi, amount: 45, payer: text.wang, participants: [text.wang, text.me] } } },
        ]
      : [{ functionCall: { name: 'show', args: { view: 'categories', from: '2026-10-01', to: '2026-10-05' } } }];
  const chunk = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] };
  return `data: ${JSON.stringify(chunk)}\r\n\r\n`;
}

async function ready(page) {
  await page.waitForSelector('header', { timeout: 20_000 });
  await page.addStyleTag({ content: '#demo-banner { display: none !important; }' });
  await page.waitForTimeout(800);
}

async function ask(page, prompt, until) {
  const input = page.locator('textarea').last();
  await input.click();
  await input.fill(prompt);
  await input.press('Enter');
  await page.getByText(until, { exact: false }).last().waitFor({ timeout: 20_000 });
}

// 等有限时长的动画播完、连续两帧一样再拍；光晕这类无限循环的动画不等
async function settled(page) {
  await page
    .waitForFunction(
      () => document.getAnimations().every((a) => a.effect?.getComputedTiming().iterations === Infinity || a.playState !== 'running'),
      null,
      { timeout: 5_000 },
    )
    .catch(() => {});
  let previous = null;
  for (let i = 0; i < 12; i++) {
    const shot = await page.screenshot();
    if (previous?.equals(shot)) return shot;
    previous = shot;
    await page.waitForTimeout(250);
  }
  return previous;
}

const SCENES = [
  { name: 'ledger-desktop', viewport: { width: 1200, height: 900 } },
  { name: 'ledger-mobile', viewport: { width: 390, height: 844 }, mobile: true },
  {
    name: 'assistant-desktop',
    viewport: { width: 1200, height: 900 },
    scenario: 'expenses',
    run: (page, text) => ask(page, text.expenses, text.pending),
  },
  {
    name: 'assistant-mobile',
    viewport: { width: 390, height: 844 },
    mobile: true,
    scenario: 'chart',
    run: (page, text) => ask(page, text.chart, text.chartReply),
  },
];

for (const [locale, text] of Object.entries(TEXT)) {
  mkdirSync(join(out, locale), { recursive: true });
  // 日期输入框等原生控件按浏览器界面语言显示：默认的 headless shell 不认 --lang，要用完整版 Chromium；Linux 上还要看 LANG
  const browser = await chromium.launch({
    channel: 'chromium',
    args: [`--lang=${locale}`],
    env: { ...process.env, LANG: `${text.posixLocale}.UTF-8`, LANGUAGE: text.posixLocale },
  });
  try {
    for (const scene of SCENES) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: scene.viewport,
          deviceScaleFactor: 2,
          isMobile: Boolean(scene.mobile),
          hasTouch: Boolean(scene.mobile),
          colorScheme: theme,
          locale,
          timezoneId: 'Asia/Shanghai',
        });
        await context.clock.setFixedTime(NOW);
        await context.addInitScript(
          ([locale, key]) => {
            localStorage.setItem('aapay:locale', JSON.stringify(locale));
            localStorage.setItem('aapay:ai-key', JSON.stringify(key));
          },
          [locale, OWN_KEY],
        );
        await context.route('https://generativelanguage.googleapis.com/**', (route) =>
          route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' },
            body: geminiReply(scene.scenario, text, route.request().postDataJSON()),
          }),
        );
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (err) => errors.push(err.message));
        await page.goto(base);
        await ready(page);
        // 首次打开会清掉本机偏好，所以等演示数据写好后再折叠管理员卡片，刷新一次生效
        await page.evaluate(() => localStorage.setItem('aapay:admin:collapsed', 'true'));
        await page.reload();
        await ready(page);
        await scene.run?.(page, text);
        const file = join(out, locale, `${scene.name}-${theme}.png`);
        writeFileSync(file, await settled(page));
        if (errors.length) throw new Error(`${file}: ${errors.join('; ')}`);
        console.log(`✓ ${file}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
