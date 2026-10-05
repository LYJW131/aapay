import { messages } from './locale.ts';

export const connect = messages({
  'zh-CN': {
    ai: {
      steps: [
        { app: 'Claude', how: '设置 → 连接器 → 添加自定义连接器，粘贴上面的地址' },
        { app: 'ChatGPT', how: '设置 → 应用与连接器 → 高级设置中打开开发者模式，再创建连接器并粘贴地址' },
        { app: '其他应用', how: 'Cursor、VS Code 等支持远程 MCP（OAuth）的客户端同样可用' },
      ],
      disconnected: (name: string) => `已断开 ${name}`,
      fallbackApp: 'AI 应用',
      copyFailed: '复制失败，请手动选择地址复制',
      serverUrl: 'MCP 服务器地址',
      copyUrl: '复制地址',
      hintAdmin: '连接时会打开授权页：选「全部账本」，AI 就能以管理员身份管理所有账本（建账本、生成口令、记账查账）；也可以只授权当前账本。',
      hintMember: '连接时会打开授权页：在已打开本账本的浏览器里可一键授权，否则输入本账本的分享口令即可。之后就能直接让 AI 记账、查账和算结算了。',
      ledgerConnections: '已连接本账本的应用',
      adminConnections: '管理员连接（全部账本）',
      adminEmpty: '还没有以管理员身份连接的应用',
    },
    welcome: {
      title: (ledger: string) => `欢迎加入「${ledger}」`,
      description: '你是哪一位？之后记账会默认由你付款',
      defaultPayer: (name: string) => `记账时默认由 ${name} 付款`,
      iAm: '我是',
      notListed: '不在里面？把自己加进来',
      addYourself: '先把自己加进来',
      namePlaceholder: '你的名字',
      add: '添加',
      skip: '跳过',
    },
  },
  en: {
    ai: {
      steps: [
        { app: 'Claude', how: 'Settings → Connectors → Add custom connector, then paste the URL above' },
        { app: 'ChatGPT', how: 'Settings → Apps & Connectors → turn on developer mode under Advanced settings, then create a connector and paste the URL' },
        { app: 'Other apps', how: 'Cursor, VS Code and other clients that support remote MCP (OAuth) work too' },
      ],
      disconnected: (name) => `Disconnected ${name}`,
      fallbackApp: 'AI app',
      copyFailed: "Couldn't copy. Please select the URL and copy it manually",
      serverUrl: 'MCP server URL',
      copyUrl: 'Copy URL',
      hintAdmin:
        'Connecting opens an authorization page. Choose "All ledgers" to let the AI manage every ledger as admin (create ledgers, generate passcodes, add and review expenses), or authorize just this ledger.',
      hintMember:
        "Connecting opens an authorization page. In a browser where this ledger is already open, it's one click; otherwise just enter this ledger's share passcode. Then you can ask the AI to add expenses, look things up and work out how to settle up.",
      ledgerConnections: 'Apps connected to this ledger',
      adminConnections: 'Admin connections (all ledgers)',
      adminEmpty: 'No apps connected as admin yet',
    },
    welcome: {
      title: (ledger) => `Welcome to "${ledger}"`,
      description: "Which one are you? New expenses will default to you as the payer",
      defaultPayer: (name) => `New expenses will be paid by ${name} by default`,
      iAm: "I'm",
      notListed: 'Not on the list? Add yourself',
      addYourself: 'Add yourself first',
      namePlaceholder: 'Your name',
      add: 'Add',
      skip: 'Skip',
    },
  },
});
