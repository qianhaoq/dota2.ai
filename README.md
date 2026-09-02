<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />

# Dota2.ai - AI 战术助手 | AI Tactical Assistant

**中文默认 | Chinese Default with English Toggle**

</div>

---

## 📖 简介 | Introduction

Dota2.ai 是一个基于 Google Gemini AI 的 Dota 2 战术助手应用，提供以下功能：

- **阵容分析 (Draft Strategy)**: 选择天辉/夜魇英雄，可选战术背景，分析对局（胜率预测、获胜条件、装备建议）
- **传说百科 (Lore Keeper)**: 与神秘商人聊天，探索 Dota 2 的传说故事

Dota2.ai is a Dota 2 tactical assistant powered by Google Gemini AI, featuring:

- **Draft Strategy**: Pick Radiant/Dire heroes, add optional strategy context, analyze matchup (win probability, win conditions, item suggestions)
- **Lore Keeper**: Chat with the Secret Shopkeeper about Dota 2 lore

---

## 🚀 本地开发 | Local Development

### 环境要求 | Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0
- Gemini API Key ([获取地址 | Get it here](https://aistudio.google.com/apikey))

### 安装步骤 | Installation

```bash
# 克隆仓库 | Clone repository
git clone https://github.com/qianhaoq/dota2.ai.git
cd dota2.ai

# 安装依赖 | Install dependencies
npm install

# 配置环境变量 | Configure environment variables
cp .env.example .env
# 编辑 .env 文件，填入你的 GEMINI_API_KEY
# Edit .env file and add your GEMINI_API_KEY
```

### 开发模式 | Development Mode

```bash
# 方式一：分别启动前端和后端 | Option 1: Start frontend and backend separately
# 终端 1 | Terminal 1:
npm start          # 启动后端服务器 (端口 8080) | Start backend server (port 8080)

# 终端 2 | Terminal 2:
npm run dev        # 启动 Vite 开发服务器 | Start Vite dev server

# 方式二：同时启动（需要 concurrently）| Option 2: Start both (requires concurrently)
npm run start:dev
```

访问 | Visit: http://localhost:5173

### 生产构建 | Production Build

```bash
# 构建前端 | Build frontend
npm run build

# 启动生产服务器 | Start production server
npm start
```

访问 | Visit: http://localhost:8080

---

## 🐳 Docker 部署 | Docker Deployment

### 本地 Docker 运行 | Local Docker Run

```bash
# 构建镜像 | Build image
docker build -t dota2-ai .

# 运行容器 | Run container
docker run -p 8080:8080 -e GEMINI_API_KEY=your_api_key dota2-ai
```

### Google Cloud Run 部署 | Deploy to Google Cloud Run

#### 1. 准备工作 | Prerequisites

确保已安装 [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) 并已登录:

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

#### 2. 构建并推送镜像 | Build and Push Image

```bash
# 启用所需的 API | Enable required APIs
gcloud services enable cloudbuild.googleapis.com run.googleapis.com

# 构建并推送到 Container Registry | Build and push to Container Registry
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/dota2-ai

# 或使用 Artifact Registry（推荐）| Or use Artifact Registry (recommended)
gcloud builds submit --tag REGION-docker.pkg.dev/YOUR_PROJECT_ID/REPO_NAME/dota2-ai
```

#### 3. 部署到 Cloud Run | Deploy to Cloud Run

```bash
gcloud run deploy dota2-ai \
  --image gcr.io/YOUR_PROJECT_ID/dota2-ai \
  --platform managed \
  --region asia-east1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=your_api_key \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 10
```

部署成功后会显示服务 URL。
After deployment, you'll receive a service URL.

#### 4. 配置自定义域名 | Configure Custom Domain

在 Cloud Run 控制台或使用 CLI 添加自定义域名:

```bash
gcloud run domain-mappings create \
  --service dota2-ai \
  --domain dota2.ai \
  --region asia-east1
```

---

## 🌐 DNS 配置 (dota2.ai) | DNS Configuration

当前 dota2.ai 域名指向 Google AI Studio 的 IPv6 地址 (`2001:4860:4802:32::15`)。
部署到 Cloud Run 后，需要更新 GoDaddy DNS 设置。

The domain dota2.ai currently points to Google AI Studio's IPv6 address (`2001:4860:4802:32::15`).
After deploying to Cloud Run, you'll need to update GoDaddy DNS settings.

### GoDaddy DNS 配置步骤 | GoDaddy DNS Configuration Steps

1. 登录 [GoDaddy](https://www.godaddy.com) 账户
2. 进入域名管理 → DNS 管理
3. 根据 Cloud Run 提供的 DNS 记录更新:

**方式一：使用 Cloud Run 的域名映射** | **Option 1: Use Cloud Run Domain Mapping**

Cloud Run 会提供需要添加的 DNS 记录，通常是:
- 删除现有的 AAAA 记录 (`2001:4860:4802:32::15`)
- 添加 Cloud Run 提供的 CNAME 记录

**方式二：使用负载均衡器** | **Option 2: Use Load Balancer**

如需更高级的配置（如 SSL 证书管理），可以使用 Google Cloud Load Balancer:
- 添加 A 记录指向负载均衡器 IP
- 添加 AAAA 记录指向负载均衡器 IPv6（如有）

---

## 📁 项目结构 | Project Structure

```
dota2.ai/
├── src/
│   ├── components/       # React 组件
│   │   ├── DraftAssistant.tsx
│   │   ├── HeroCard.tsx
│   │   └── LoreChat.tsx
│   ├── services/         # API 服务
│   │   ├── dotaApiService.ts
│   │   └── geminiService.ts
│   ├── App.tsx           # 主应用组件
│   ├── types.ts          # TypeScript 类型定义
│   ├── constants.ts      # 常量配置
│   ├── index.css         # 全局样式 (Tailwind)
│   └── main.tsx          # 应用入口
├── public/               # 静态资源
├── server.js             # Express 后端服务器
├── Dockerfile            # Docker 构建文件
├── vite.config.ts        # Vite 配置
├── tailwind.config.js    # Tailwind 配置
└── package.json          # 项目依赖
```

---

## 🔧 环境变量 | Environment Variables

| 变量名 | 必需 | 默认值 | 描述 |
|--------|------|--------|------|
| `GEMINI_API_KEY` | ✅ | - | Google Gemini API 密钥 |
| `PORT` | ❌ | 8080 | 服务器端口 |
| `HOST` | ❌ | 0.0.0.0 | 服务器主机地址 |

---

## 🔗 API 端点 | API Endpoints

| 端点 | 方法 | 描述 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/api/health` | GET | API 健康检查（含配置状态）|
| `/api/analyze` | POST | 分析阵容对局 |
| `/api/chat` | POST | 传说百科聊天 |

---

## 📧 联系方式 | Contact

如果你对 Dota 2 与 AI 感兴趣，请联系我:
If you are interested in Dota 2 and AI, please contact me:

**Email:** qianhao1229@gmail.com

---

## 📜 许可证 | License

MIT License
