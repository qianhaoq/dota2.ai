# 仓库迁移与验收

## 基线与范围

main @ 98b91e27e13118ede2a9be425bb3e730e397482e。已核对当前分支、AGENTS.md、Copilot 说明、reviewCards 类型；会话此前已读 App、CoachView、HomeModules、ReviewEntry、ReviewSurface、选人组件、HeroHub/HeroDetail、前端服务、MatchFact 和导师说明。不是全部后端逐行审计。

README 和导师旧文档落后于已实现复盘，不能用旧文档删除功能。保留 React/TypeScript/Vite/Tailwind、DeepSeek 和既有 SSE。

## 原模块映射

| 原文件/能力 | 新归属 | 关键处理 |
|---|---|---|
| App.tsx | WorkspaceShell | 保留语言/safe-area/visualViewport，状态不随资料页卸载 |
| CoachView.tsx | SessionController + Surface | 保留 stream guard，拆任务命令/会话/视图 |
| MentorStage/Picker | 教练与练习对象 | mentor/practice/focus 独立 |
| HomeModules/LessonRail | 动机与任务入口 | 切目标不自动生成，显式执行 |
| ReviewEntry | MatchIntake | 先事实后视角，实际名单，身份校验 |
| ReviewSurface/ReviewInsightCards | ReviewWorkspace/DecisionFork/EvidenceLens | 复用 reviewCards，不铺满卡片 |
| ResultCard/CoachCanvas | 兼容结果层 | 旧回答安全回退，不靠标题解析驱动新 UI |
| coach/a2ui | 基础 primitives | 扩展领域组件，不把美化卡片称协议接入 |
| HeroPickerOverlay/DraftContextChip | DraftBoard | mySide 与编辑目标分离，逐格编辑与撤销 |
| HeroHub/HeroDetail | KnowledgeLens/Codex | 完整资料、局部重试、上下文抽屉 |
| LoreChat/shopkeeper | 背景页演绎 | 官方与模型文本分开 |
| geminiService.ts | 原服务 adapter | 不因旧文件名更换 AI 提供方 |
| lib/matchReview | 事实与证据边界 | 复用解析和约束，小步扩展 |

## 接口能力与缺口

- `/api/meta/heroes`、`/api/meta/heroes/:id`：英雄/别名/图片/技能/属性/背景。缺失字段留空，不虚构当前版本机制。
- `GET /api/review/:matchId`：实际名单、摘要、可用统计/事件；不是 Steam 身份关联或精确回放。
- `POST /api/review/:matchId`：matchFact、reviewCards、notice、text、grounded；不是反事实胜率模拟。
- `/api/suggestions`：有来源候选；必须区分失败、空结果和缺上下文。
- `/api/analyze`：阵容上下文与对位分析；样本胜率不是本局获胜概率。
- `/api/playbook`：阶段打法和装备资料；不是实际购买时间线或技能 CD 追踪。
- `/api/meta/tier`：来源、样本、cacheAge；不伪装接口不存在的补丁/段位筛选。
- `/api/chat`：神秘商人；生成故事不算官方事实。

当前 MatchFact 有统计、分路推断、经济和目标事件，没有逐时刻坐标/视野。因此真实复盘 P0 使用非空间证据；地图仅为明确教学示意。真实空间能力必须依赖新增数据服务，不能靠 prompt 或 UI 伪造。

## 分期实施

1. 稳定工作区与 token：保留旧功能和 v3 回滚开关；切页不丢复盘/草稿/选人；补齐中英文与焦点/软键盘。
2. 一个真实复盘闭环：事实 → 关键判断 → 证据 → 保存动作；没有坐标就不画真实地图。测试部分数据、模型不可用、取消、重试、旧响应、权限。
3. 领域 surface 与事件：先 DecisionFork/EvidenceLens/PracticeCommit，再固定官方 A2UI 版本及 catalog adapter。测试未知组件、恶意输入、URL、越权证据、事件重放、版本缺口、幂等、焦点。
4. 阵容与装备：独立 mySide、候选预览/采用、逐格撤销、失效管理；新阵容不复用旧结论。
5. 训练/图鉴/笔记：先答后讲、多解与反例、资料查阅、官方与演绎区分；本机/账户边界；存储失败与删除撤销；人工完成不当作客观提升。

后续而非当前承诺：账户同步、真实逐时刻位置/视野、跨局训练验证。新增 agent event endpoint 和官方协议适配是显式后端任务，当前没有就不假调用。

建议目录：src/app，src/features/{review,draft,practice,knowledge,journal}，src/coach-ui/{catalog,renderer,events,validators,evidence,adapters,components}。这是生产目标，不是本轮已创建目录。独立 HTML 只作参考，不整段粘入 React。

生产 PR 必须遵循 AGENTS.md：npm test、npx tsc --noEmit、npm run build、node --check server.js；SSE/API/部署单独标风险。保留旧页面开关、历史结果读取与存储迁移。不能大改 server.js 或改 CI 绕门禁。

## 原型验证与限制

30 项 Node 核心测试，64 项 Chromium 浏览器检查；7 个路由在 375/390/768/1024/1600px 无页面横向溢出。覆盖取消后旧结果、选择后讲解、去重/撤销、上下文草稿、抽屉焦点、输入格式、保存去重。

浏览器使用 set_content 和内存 Storage adapter；测试序列化/恢复，不等于跨刷新 localStorage、账户同步、iOS 真机或读屏认证。未测试真实 AI/比赛 API 或官方 A2UI 全兼容。

本地 git clone 因环境无法解析 GitHub 域名失败；通过 GitHub 连接器读取/写入设计分支。因此没有在完整生产仓库跑 CI，不声称完整项目构建通过。设计目录外保持不变。
