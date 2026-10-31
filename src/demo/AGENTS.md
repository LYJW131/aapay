# src/demo

GitHub Pages 上的演示站：真实的 `createApp()`、`RegistryService` / `LedgerService` 连同 sql.js 跑在访客的浏览器里。README 的截图也从这里生成。跨目录的规则见根 `AGENTS.md`。

## 组成

- `main.ts`：入口。初始化 sql.js，从 IndexedDB 读回数据库，装好转接，首次打开时用 `seed.ts` 写入演示账本，然后加载 `src/web/main.tsx` 并挂上顶部横幅（`Banner.tsx`）。
- `platform.ts`：`Platform` 的浏览器实现。每个账本一个 sql.js 数据库，实时推送在内存里的 `Room` 之间转发；每个浏览器生成自己的审计签名钥，和数据库一起存进 IndexedDB（`store.ts`）。
- `server.ts`：把请求交给 Hono 应用。浏览器会从 `Request` 里丢掉 `Cookie`、`Upgrade` 这类受限请求头，响应里的 `Set-Cookie` 也拿不到，所以 Cookie 存在自己的罐子里（localStorage `aapay-demo:cookies`），请求头换成不受限的 `Headers`，`Set-Cookie` 在注入的中间件里截下。
- `shims.ts`：全局 `fetch` 对 `SERVER_PATHS` 内的同源请求转给 `server.ts`，其余照常发出（访客自带 Key 时，模型请求从浏览器直连服务商）。全局 `WebSocket` 对 `/api/*` 换成 `DemoWebSocket`，服务端用 `c.env.socket` 认出它。
- `seed.ts`：演示数据，中英两套，`scripts/seed.mjs`（`npm run seed`）共用。

## 不变量

- 演示站的配置固定在 `server.ts` 的 `createServer`：`isolated` 模式、`ADMIN_AUTH=none`、关闭 MCP（外部 AI 应用连不到浏览器里的服务端）、AI 助手只能自带 Key。
- 访客默认以成员身份进入；打开 `/admin` 时 GitHub Pages 把 `/api/admin/login` 的整页跳转交给 `404.html`，`main.ts` 把它转给浏览器内的服务端后按 `Location` 跳回。
- sql.js 的 `export()` 会关闭再重开数据库，连接级 PRAGMA 失效，导出一律走 `sqlite.ts` 的 `exportDb`。
- 只用纯静态托管能提供的东西：没有自定义响应头（COOP/COEP），所以不用 OPFS 或 SharedArrayBuffer。

## 截图

- `scripts/screenshots.mjs` 对 `vite preview` 起的 `dist/demo` 截图：固定时钟（`NOW`）、拦截 Gemini 请求返回固定的函数调用与回复、隐藏横幅，按 `SCENES` × 中英 × 深浅色输出到 `dist/demo/shots/<语言>/<场景>-<主题>.png`。
- `.github/workflows/demo.yml` 每次发布演示站时重新生成，README 直接引用 `https://aapay.lyjw.me/shots/...`。改了场景名要同步 README 的引用。
- 本地验证：`npm run build:demo`，起 `.claude/launch.json` 的 `demo-dist`，再 `npm run screenshots -- http://localhost:5176 dist/demo/shots`。
