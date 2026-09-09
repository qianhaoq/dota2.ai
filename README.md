<div align="center">

# DOTA2.AI

**看清局面，练好下一次判断。**

面向 Dota 2 玩家的 AI 战术教练：赛前准备、赛后复盘、英雄修炼。

中文优先 · 现有应用支持英文切换

[运行应用](#quick-start) · [体验 V3 原型](#v3-preview) · [产品设计](docs/design/tactical-coach-v3/docs/DESIGN.md) · [参与开发](#development)

</div>

---

DOTA2.AI 希望解决的，不是“这局有多少数据”，而是三个更实际的问题：**眼前是什么局面？我有哪些选择，各自的代价是什么？下一局可以练好哪一个动作？**

我们将产品围绕一条教练循环重新组织：

**局面 → 判断 → 可操作推演 → 玩家补充或选择 → 教练修正 → 下局练习。**

数字用来解释判断，不是页面的主角。聊天是提问方式，英雄是分析对象，装备是取舍，时间线是证据；只有数据足以支持空间判断时，地图才应该出现。

> **当前状态**：仓库同时包含可运行的现有应用，以及 V3 全站设计和独立交互原型。V3 目前位于 `docs/design/tactical-coach-v3/`，尚未替换 `src/` 中的应用前端。设计已进入仓库，不代表对应功能已经接入真实服务或部署上线。

## 当前能做什么

现有应用基于 React、Express 与 DeepSeek，结合 OpenDota 数据提供以下能力。实际可用内容取决于外部数据和后端配置，不保证每场比赛都有完整数据。

| 场景 | 当前实现 |
| --- | --- |
| 赛后复盘 | 输入比赛 ID 或受支持链接，先读取比赛事实，再选择本场英雄视角；展示阶段节奏、关键节点、复盘建议与下一局练习，支持围绕该场比赛追问。 |
| 阵容与打法 | 录入天辉、夜魇英雄，分析对位关系、查询下一手候选，生成本局打法与阶段装备参考。 |
| 英雄带练 | 选择练习英雄，围绕 BP、对局、出装与思路提问；当前课时仍复用现有分析服务，不等于完整训练系统。 |
| 英雄资料 | 查询英雄名称与别名、技能、属性、背景和版本趋势；仓库另保留神秘商人聊天组件与接口。 |

分析结果中的数据来源不等于结论已被证实。样本胜率不是本局获胜概率，复盘建议也不是对玩家表现的确定性裁决。

## V3：从读报告，到一起做判断

V3 不再把所有功能塞进聊天首页，而是保留四个稳定入口，在当前任务中展开需要的交互：

```text
战术室
├── 刚打完：导入比赛 → 选择视角 → 拆解关键决定
├── 准备开局：录入已知阵容 → 比较候选 → 明确本局任务
└── 装备取舍：眼前威胁 → 两条路线 → 前提、代价与改选条件
英雄修炼：冻结情境 → 玩家先判断 → 教练拆解 → 保存练习
英雄图鉴：查英雄、技能与背景；趋势和神秘商人作为资料层
战术笔记：保存一个动作 → 下一局尝试 → 再次检查
```

**先给一个值得检查的决定。** 复盘先回答“这次为什么要跟进”，再按需展开统计与依据，而不是先铺满 KDA、伤害排行和经济曲线。赶时间可以直接看要点；想学明白，可以比较另一种选择；想练习，可以先答后讲。

**让 Dota 元素承担操作。** 英雄阵列用于选择与对比，技能和物品用于讨论配合与取舍，迷雾表示未知，虚线表示假设。拉比克是教练的表达方式，不是事实来源；更换导师不应该改写比赛视角或提高分析可信度。

**把建议带进下一局。** 保存的是“触发情境＋实际动作＋检查方法”，不是整份报告。自我勾选完成不等于能力提升，更不等于系统已经观察到进步。

这些是 V3 的设计目标与原型体验，不是对当前生产功能的承诺。完整流程、视觉语义与状态规则见 [产品与交互设计](docs/design/tactical-coach-v3/docs/DESIGN.md)。

## A2UI：让问题决定交互对象

V3 借鉴 A2UI 的可信组件、局部更新与动作回传思路：教练不只输出一段文字，而是根据当前问题组织适合的交互对象。

| 玩家在问什么 | 对应的交互对象 |
| --- | --- |
| “这次进场要先确认什么？” | 关键节点、威胁关系、信息缺口与证据抽屉。 |
| “换一个英雄会怎样？” | 阵容编辑、候选预览、配合与代价比较。 |
| “先保命还是先补输出？” | 装备路线、成立条件与改选条件。 |
| “下一局怎么练？” | 先答后讲的情境题，以及可保存的练习动作。 |

应用负责稳定的导航、上下文、输入草稿、焦点和取消；Agent 负责提出关键问题、组织解释与选择组件。玩家的操作带着任务和版本信息返回，只更新相关对象，不把整个页面重新生成一遍。

事实、模型推断、用户回忆、假设推演和教学演示必须分开。用户说“我当时看见了”，可以成为分析条件，但不能被自动写成已验证的坐标或视野数据。

> 当前 V3 原型使用内部领域运行时，**不是官方 A2UI wire protocol 兼容实现**，也没有接入真实 Agent。标准协议适配、组件校验与生产动作处理需要独立实现和验收。详见 [A2UI 组件与事件契约](docs/design/tactical-coach-v3/docs/A2UI.md)。

<a id="quick-start"></a>
## 运行现有应用

需要 Node.js、npm、仓库访问权限，以及用于 AI 分析的 DeepSeek API Key。项目 `engines` 声明 Node.js ≥18，当前 Docker 配置使用 Node.js 20；版本约束见 [package.json](package.json) 和 [Dockerfile](Dockerfile)。以下命令适用于 macOS、Linux 或 WSL 的 Bash/Zsh。

### 安装与配置

```bash
git clone https://github.com/qianhaoq/dota2.ai.git
cd dota2.ai
npm ci
cp .env.example .env
```

使用已授权的 GitHub 账号克隆；配置好 SSH 后，也可以使用 `git@github.com:qianhaoq/dota2.ai.git`。

编辑 `.env`，填入自己的配置。示例文件见 [.env.example](.env.example)。

| 环境变量 | 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | AI 分析所需的服务端密钥。未配置时不能调用 DeepSeek；部分数据查询可独立使用。 |
| `PORT` | 后端监听端口，默认 `8080`。 |
| `HOST` | 后端监听地址，默认 `0.0.0.0`；仅本机开发可设为 `127.0.0.1`。 |
| `STEAM_WEB_API_KEY` | 后端额外支持的可选配置，用于获取 Steam 本地化英雄名称；未配置时使用回退数据。可自行添加到 `.env`。 |

**后端当前读取 `process.env`，不会自动加载 `.env`。** 在当前终端导入自己维护的配置文件后，再启动开发服务：

```bash
set -a
. ./.env
set +a
npm run start:dev
```

前端地址以 Vite 的终端输出为准，通常为 `http://localhost:5173`；后端默认监听 `8080`。也可以在两个终端分别运行 `npm start` 和 `npm run dev`，其中后端终端需要先导入环境变量。

`/api` 的开发代理固定指向 `http://localhost:8080`。修改后端端口后，需要同步修改 [vite.config.ts](vite.config.ts)。密钥只放在后端环境，不要使用 `VITE_` 前缀暴露给浏览器，也不要提交 `.env`。

### 构建与本地运行

在已导入环境变量的终端执行：

```bash
npm run build
npm start
```

默认访问 `http://localhost:8080`。构建产物位于 `dist/`，由 Express 提供服务。

### Docker

```bash
docker build -t dota2-ai .
docker run --rm --env-file .env \
  -e PORT=8080 -e HOST=0.0.0.0 \
  -p 127.0.0.1:8080:8080 dota2-ai
```

该示例只将服务发布到本机 `8080` 端口；Docker 通过 `--env-file` 注入配置，不需要先在 shell 中导入。生产发布另需配置密钥注入、访问控制、请求限流和流式响应超时；部署触发器与域名配置以实际环境为准。

<a id="v3-preview"></a>
## 体验 V3 交互原型

原型独立于现有应用，不需要安装 npm 依赖或配置 DeepSeek 密钥。需要 Python 3；在仓库根目录启动本地静态服务：

```bash
python3 -m http.server 4173 --bind 127.0.0.1 \
  --directory docs/design/tactical-coach-v3
```

打开 `http://127.0.0.1:4173/prototype/`。请通过 HTTP 服务访问，而不是直接双击 `prototype/index.html`。

原型可体验复盘条件比较、证据抽屉、逐格选人、替换与撤销、装备路线比较、训练先答后讲和本机笔记。英雄图片通过 Valve CDN 加载，加载失败时保留可读名称。

**演示边界**：`TF-01` 是固定教学情境，不是真实比赛；比赛输入只做格式校验，自然语言跳转使用固定规则。地图、时刻和路线是示意，没有真实 AI、Steam 账号、比赛导入、录像播放器或逐时刻位置/视野接入。独立原型目前为中文，不能替代生产双语与真机验收。

<a id="development"></a>
## 工程结构与开发

现有应用使用 React 18、TypeScript、Vite、Tailwind CSS 与 Express；后端通过 OpenAI SDK 调用 DeepSeek，测试使用 Vitest。`geminiService.ts` 是历史文件名，不代表当前模型提供方。

```text
dota2.ai/
├── src/
│   ├── App.tsx                       # 现有应用入口
│   ├── components/
│   │   ├── CoachView.tsx              # 教练、分析与复盘编排
│   │   ├── coach/                    # 输入、结果、复盘与现有卡片组件
│   │   ├── HeroHub.tsx                # 英雄资料入口
│   │   └── HeroDetail.tsx             # 英雄详情
│   ├── services/                     # 数据请求与 AI 流式接口
│   ├── types/                        # 比赛事实、复盘卡片等结构
│   └── utils/                        # 上下文、取消、流式和状态工具
├── lib/matchReview/                   # 后端比赛事实、分路推断与复盘处理
├── server.js                         # Express、数据缓存与 DeepSeek 调用
├── docs/design/tactical-coach-v3/
│   ├── docs/                         # 产品、A2UI、迁移计划与视觉 token
│   └── prototype/                    # 独立原型与运行时测试
├── .github/workflows/                # CI、审查与合并门禁
├── AGENTS.md                         # 开发 Agent 操作约定
└── Dockerfile                        # 应用构建与运行镜像
```

### 检查命令

在仓库根目录安装依赖后，执行应用检查：

```bash
npm test
npx tsc --noEmit
node --check server.js
npm run build
```

V3 独立原型使用单独的检查命令，不包含在上述应用测试中：

```bash
node --test docs/design/tactical-coach-v3/prototype/runtime.test.mjs
node --check docs/design/tactical-coach-v3/prototype/app.mjs
```

原型测试通过不代表生产接口、账户同步、真实持久化、iOS 软键盘或读屏体验已通过验收。

### 参与开发

先阅读 [AGENTS.md](AGENTS.md)，再按照 [迁移计划](docs/design/tactical-coach-v3/docs/MIGRATION.md) 分阶段实施。优先打通一个真实的“比赛事实 → 关键判断 → 可追溯依据 → 下局动作”闭环，再扩展阵容、装备与训练。

复用现有服务、类型与事实处理，避免为了换界面而重写整个后端。修改流式分析时，保留取消、旧响应隔离、部分结果和同一任务重试；只改变编辑目标，不应改变玩家视角或清空其他任务。涉及新交互时同步检查中文与英文、桌面与手机，以及缺数据和请求失败的状态。

提交 PR 时使用 [PR 模板](.github/pull_request_template.md)，说明验证范围和风险。自动合并条件以 [合并门禁](docs/MERGE_GATES.md) 为准；尚待评审的设计或不确定变更保持 Draft，不绕过检查。

## 设计与工程文档

| 文档 | 内容 |
| --- | --- |
| [V3 总览](docs/design/tactical-coach-v3/README.md) | 设计交付范围、原型启动与能力边界。 |
| [产品与交互](docs/design/tactical-coach-v3/docs/DESIGN.md) | 七个工作区、教练方式、状态、视觉与文案。 |
| [A2UI 契约](docs/design/tactical-coach-v3/docs/A2UI.md) | 组件目录、局部更新、动作回传、证据与协议边界。 |
| [迁移计划](docs/design/tactical-coach-v3/docs/MIGRATION.md) | 现有文件与接口映射、分期、验收与回滚。 |
| [视觉 Token](docs/design/tactical-coach-v3/docs/tokens.json) | V3 配色与视觉建议；尚未覆盖应用现有 token。 |
| [质量规范](docs/QUALITY.md) | 应用质量检查与开发流程。 |
| [合并门禁](docs/MERGE_GATES.md) | CI、审查和自动合并规则。 |

## 数据与能力边界

DOTA2.AI 帮助玩家理解和练习决策，不替玩家操作游戏，也不承诺胜率提升、段位增长或唯一最优解。

当前比赛事实结构没有逐时刻坐标和视野，不能据此还原真实走位或断言玩家当时看到了什么。没有空间数据就使用事件、分路示意或非空间证据；没有可靠依据就标注未知，而不是补出一个看似精确的答案。

分析依赖公开比赛数据、可用的英雄资料与用户提供的上下文。缺字段、样本不足、版本不明或服务不可用时，应保留这些限制。官方资料、模型演绎、用户回忆和教学假设不能混为一谈。不要提交密钥、私人对话或未经授权的用户数据。

## 许可与联系

代码许可沿用原 README 的 MIT 声明；仓库目前尚未附完整 `LICENSE` 文件，待维护者补齐。第三方游戏图像、名称和商标不由本项目重新授权。本项目为个人项目，并非 Valve 官方产品。

维护者：**qianhaoq** · 联系邮箱：**qianhao1229@gmail.com**。
