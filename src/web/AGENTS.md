# src/web

前端（React + Tailwind）。跨目录的规则见根 `AGENTS.md`。

## 接口

- 用 `hono/client` 拿到 `ApiType` 的端到端类型；新增接口时把路由链在 `src/server/app.ts` 的 `buildApi()` 里，前端就能类型安全地调用。
- 管理功能是账本页顶部的「管理员卡片」（`features/admin/AdminCard.tsx`，按需加载）；`/admin` 只是登录入口页。前端从 `/api/session` 的 `admin` 字段得知管理员身份，管理接口返回 401 时由 `onAdminExpired`（`lib/api.ts`）统一清掉管理员状态。
- `/oauth/authorize` 是前端页面（`features/oauth/AuthorizePage.tsx`）。

## 国际化

- 语言是 `zh-CN` / `en`。文案在 `i18n/`，按功能分文件，用 `messages({ 'zh-CN': {...}, en: {...} })` 定义（en 的结构由类型约束与 zh 一致），带参数或复数的文案写成函数。
- 语言在页面加载时确定（localStorage `aapay:locale`，否则按浏览器语言），切换语言直接刷新页面，所以模块顶层可以直接取文案。
- 前端请求带 `Accept-Language`，服务端据此翻译错误（见 `src/server/AGENTS.md`）。

## 界面

- 界面文案求短：页面上直接显示的说明、提示、空状态、toast 都只写一句短话，第一眼能看完，不写成段的长句。放不下但仍有用的细节收进 `components/Hint.tsx`（问号图标，桌面悬停、触屏点击展开）；不重要的细节直接删掉。中英两种语言都按此要求，新增或修改文案时检查。
- 内容容器保持圆角（`card`、`rounded-2xl` / `rounded-3xl`，细描边加浅阴影），手机版也一样；只有顶栏、底部标签栏这类贴边的界面框架可以不带圆角。
- iOS Safari 聚焦字号小于 16px 的输入框时会自动放大页面，且不会缩回。所有 `input` / `textarea` / `select` 在触屏上都必须至少 16px：优先用 `index.css` 的 `.field`（已带 `pointer-coarse:text-base`），不要再给它加 `text-sm` / `text-[13px]` 等更小字号；不用 `.field` 的自定义输入框（如 `features/assistant/Composer.tsx` 的输入框、`features/ledger/ExpenseForm.tsx` 按金额分摊的金额输入）必须自己加 `pointer-coarse:text-base`。桌面端可以保留小字号。

## AI 助手

- 在 `features/assistant/`：`store.ts` 管对话、变更集状态、确认与撤销，`AssistantDock` 是底部输入条与面板，`Conversation` / `ChangeCards` / `Views` 分别渲染对话、待确认卡片与查账图表（数字由前端用实时账本计算，模型只选 `AssistantView` 的种类与参数），`Composer` 与 `speech.ts` 处理输入、拍照与语音，`KeySheet` 是自带 Key 面板；文案在 `i18n/assistant.ts`。
- 用户自带 Key 存在浏览器 localStorage（`own-key.ts` 的 `OWN_KEY_STORAGE`），每次请求以请求头透传，服务端规则见 `src/server/AGENTS.md`「AI 助手」。

## 演示站

- 同一份前端也是演示站的界面，`src/demo/main.ts` 在加载 `main.tsx` 之前装好 fetch 与 WebSocket 的转接。前端代码不感知演示站：请求走全局 `fetch`、实时连接走全局 `WebSocket`，不要绕开它们（比如在模块顶层缓存 `fetch` 引用）。
