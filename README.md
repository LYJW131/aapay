# AAPay - 智能分账助手

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/python-3.13-blue.svg)
![React](https://img.shields.io/badge/react-19-61dafb.svg)

AAPay 是一款现代化的多用户分账应用，专为聚餐、旅行、合租等场景设计。支持实时同步、会话隔离和灵活的费用分摊方式。

## ✨ 功能特性

- **👥 多用户管理** - 支持最多 20 名成员，支持自定义头像
- **💰 灵活分账** - 平均分摊，轻松记录每笔支出
- **📊 每日汇总** - 按日期自动汇总支出，清晰直观
- **🔄 债务结算** - 智能计算最优转账方案，最小化交易次数
- **🔐 会话隔离** - 多账本独立管理，互不干扰
- **🔗 分享短语** - 通过短语快速加入会话，安全便捷
- **📡 实时同步** - 基于 SSE 的实时数据推送，多端同步更新
- **🛡️ OAuth2 认证** - 管理员界面支持 OAuth2 安全认证

## 🏗️ 技术栈

### 前端
- **React 19** - 现代化 UI 框架
- **Vite** - 极速开发构建工具
- **TailwindCSS** - 原子化 CSS 框架
- **Framer Motion** - 流畅动画库
- **Lucide React** - 精美图标库
- **Axios** - HTTP 客户端

### 后端
- **FastAPI** - 高性能 Python Web 框架
- **SQLite** - 轻量级数据库
- **JWT** - 安全令牌认证
- **SSE (Server-Sent Events)** - 实时事件推送

### 部署
- **Docker & Docker Compose** - 容器化部署
- **Nginx** - 反向代理 & 静态资源服务
- **OAuth2-Proxy** - 管理员认证代理

## 📁 项目结构

```
aapay/
├── backend/                # 后端服务
│   ├── main.py            # FastAPI 主入口
│   ├── logic.py           # 业务逻辑层
│   ├── database.py        # 数据库操作
│   ├── auth.py            # 认证模块
│   ├── admin_routes.py    # 管理员路由
│   ├── admin_database.py  # 管理员数据库
│   ├── models.py          # 数据模型
│   └── requirements.txt   # Python 依赖
├── frontend/              # 前端应用
│   ├── src/
│   │   ├── App.jsx        # 主应用组件
│   │   ├── components/    # UI 组件
│   │   ├── services/      # API 服务
│   │   └── utils/         # 工具函数
│   └── package.json
├── Dockerfile             # Docker 镜像构建
├── docker-compose.yaml    # 容器编排配置
├── nginx.conf             # Nginx 配置
└── env.example            # 环境变量示例
```

## 🚀 快速开始

### 环境要求

- Docker & Docker Compose
- Node.js 18+ (本地开发)
- Python 3.13+ (本地开发)

### 1. 克隆项目

```bash
git clone <repository-url>
cd aapay
```

### 2. 配置环境变量

```bash
cp env.example .env
```

编辑 `.env` 文件：

```env
TZ=Asia/Shanghai
JWT_SECRET=your-super-secret-key-here
SESSION_ISOLATION=true

# OAuth2-Proxy 配置 (用于管理员认证)
OAUTH2_PROXY_...
```

### 3. 构建前端

```bash
cd frontend
npm install
npm run build
cd ..
```

### 4. 启动服务

```bash
docker-compose up -d
```

服务将在 `http://localhost:30980` 启动。

## 💡 使用说明

### 普通用户

1. **获取分享短语** - 从管理员处获取分享短语
2. **输入短语** - 在首页输入分享短语加入会话
3. **添加成员** - 创建参与分账的成员
4. **记录支出** - 填写支出描述、金额、付款人和参与者
5. **查看结算** - 在"转账结算"卡片查看最优还款方案

### 管理员

1. **OAuth2 登录** - 访问 `/oauth2/start` 进行认证
2. **创建会话** - 在管理面板创建新的分账会话
3. **生成短语** - 创建带有效期的分享短语
4. **分发短语** - 将短语分享给参与者

## 🔧 开发指南

### 本地开发

**启动后端：**

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

**启动前端：**

```bash
cd frontend
npm install
npm run dev
```

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/users` | 获取所有用户 |
| `POST` | `/api/users` | 创建用户 |
| `DELETE` | `/api/users/:id` | 删除用户 |
| `GET` | `/api/expenses` | 获取支出列表 |
| `POST` | `/api/expenses` | 创建支出 |
| `DELETE` | `/api/expenses/:id` | 删除支出 |
| `GET` | `/api/summary` | 获取每日汇总 |
| `GET` | `/api/events` | SSE 事件流 |
| `POST` | `/auth/exchange` | 短语换取令牌 |
| `GET` | `/auth/check` | 检查认证状态 |

### 管理员 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/admin/sessions` | 获取所有会话 |
| `POST` | `/admin/sessions` | 创建会话 |
| `DELETE` | `/admin/sessions/:id` | 删除会话 |
| `GET` | `/admin/phrases` | 获取分享短语 |
| `POST` | `/admin/phrases` | 创建分享短语 |
| `DELETE` | `/admin/phrases/:id` | 删除分享短语 |

## 🔒 安全配置

### Nginx 限流

项目已配置限流保护：

- **API 端点**: 10 请求/秒，突发 20 请求
- **认证端点**: 5 请求/秒，突发 10 请求

### JWT 认证

- 用户端使用 JWT 令牌认证
- 令牌通过 Authorization Header 传递
- 管理员端使用 OAuth2-Proxy 保护

## 📋 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TZ` | 时区设置 | - |
| `JWT_SECRET` | JWT 签名密钥 | - |
| `SESSION_ISOLATION` | 会话隔离模式 | `true` |

## � 会话隔离模式

通过环境变量 `SESSION_ISOLATION` 可以切换应用的运行模式：

### 隔离模式 (`SESSION_ISOLATION=true`)

**适用场景：** 多团队/多场景使用，如同时管理多个不同聚会的账单

| 特性 | 说明 |
|------|------|
| **多会话支持** | 管理员可创建多个独立会话（账本） |
| **数据隔离** | 每个会话拥有独立的数据库文件 |
| **分享短语** | 用户通过分享短语加入指定会话 |
| **OAuth2 认证** | 管理员需通过 OAuth2 登录管理后台 |
| **SSE 隔离** | 实时事件仅推送给同会话用户 |

**工作流程：**
1. 管理员登录后台 → 创建会话 → 生成分享短语
2. 用户输入分享短语 → 获取 JWT 令牌 → 进入对应会话
3. 同会话用户数据实时同步，不同会话完全隔离

### 共享模式 (`SESSION_ISOLATION=false`)

**适用场景：** 单一固定团队使用，如长期合租室友

| 特性 | 说明 |
|------|------|
| **单一账本** | 所有用户共享同一个数据库 |
| **无需认证** | 用户直接访问，无需输入短语 |
| **简化部署** | 无需配置 OAuth2-Proxy |
| **即开即用** | 适合小团队快速使用 |

**配置方式：**

```yaml
# .env
  SESSION_ISOLATION=false
```

> [!TIP]
> 如果只是个人或固定小团队使用，推荐使用共享模式，配置更简单。  
> 如果需要管理多个独立账本（如多次聚会），请使用隔离模式。

## �📄 许可证

MIT License

---

**Made with ❤️ by AAPay Team**
