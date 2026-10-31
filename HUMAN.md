# HUMAN.md

> 给 lyjw 看：在 AAPay 里你和 agent 怎么分工、什么时候会来找你。给 agent 的硬规则在 [`AGENTS.md`](./AGENTS.md)，通用约定在 agent-playbook 的 `HUMAN.md`，这里只写本项目不同的地方。

## 一眼看完

- 推 `main` 就是发布生产（Workers Builds 自动部署，Docker 镜像同时重建）。agent 默认在分支上做、开 PR，你说「推 main」「合入 main」才进 `main`。
- 每个分支自动有两样东西可看：Worker Preview（`<分支名>-aapay.<子域>.workers.dev`）和 CI 里跑通的演示站截图。
- 演示站 <https://aapay.lyjw.me> 由 `DEMO_BRANCH` 指定的分支（默认 `main`）发布；README 的截图就是它每次发布时现拍的。
- 「已部署」看 `/version.json` 的 `commit`：生产看站点自己的，演示站看 <https://aapay.lyjw.me/version.json>。

## 本项目特有的说法

| 你说 | agent 做到 |
| --- | --- |
| 「推预览」「开 preview」 | 推分支，给出 Worker Preview 地址 |
| 「推 main」「合入 main」 | 本地 `npm run check` 通过后推 `main`，再核对生产 `/version.json` |
| 「起个本地的给我玩」 | 起开发服务器并给出地址；只看界面时用演示站（`npm run dev:demo`），不用配密钥 |
| 「更新截图」 | 不用手动做：改了界面推分支，CI 会重拍；要先看就本地跑 `npm run screenshots` |

## 什么来问你

- 合并有界面外观变化的 PR（附桌面和 375px 截图）。
- 改生产配置：Workers Builds 的构建变量和密钥、Cloudflare 上的域名与 Access、仓库变量和 Pages 设置。
- 往生产 AI 助手换服务商或换 Key。

## 仓库外的配置

- 演示站：仓库变量 `DEMO_URL`、`DEMO_BRANCH`，Pages 的自定义域名，Cloudflare 上 `aapay` 子域指向 `lyjw131.github.io` 的 CNAME（仅 DNS，不走代理）。
- 生产：仓库变量 `PRODUCTION_URL`、`PREVIEW_HOST`、`ALIYUN_ACR_IMAGE`，其余在 Workers Builds 里。
