# A2UI 范式与 Dota 领域契约

## 概念与边界

Agent 描述所需界面，客户端从可信组件目录渲染；用户操作带着上下文返回，Agent 更新同一界面的局部。不是 Markdown 分段，不是任意生成 HTML/JS/CSS。

`dota-coach-ui/1` 是内部领域模型，**不是官方 A2UI wire protocol**。组件模型、框架实现、现有 SSE 运输层分别隔离。正式协议适配、catalog negotiation 和一致性测试单独交付。

2026-09-09 核对资料：
- https://a2ui.org/
- https://a2ui.org/concepts/actions/
- https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/

官方首页当时标注 v0.9.1 current / v1.0 candidate。接入时固定版本和对应 schema，不依赖 latest 或旧搜索摘要。

## 三层职责

应用控制全局导航、身份、计费提交、输入草稿、焦点、滚动、隐私与组件样式。Agent 仅编排允许区域内的判断、问题、备选方案和动作建议。事实服务控制来源、完整性与可信度；LLM 只能引用事实 ID，不能自己写 verified=true。

可信渲染器不是完整安全保证；仍要校验数据、资源预算、URL、授权和服务端动作。

## 领域目录

| 组件 | 用途与操作 | 降级 |
|---|---|---|
| CoachBrief | 一句话要点、条件与边界 | 待澄清问题 |
| TacticalMap | 英雄/标记/假设路线/图层 | 关系图或非空间时间线 |
| DraftBoard | 固定格、预览、采用、撤销 | 已知阵容与任务澄清 |
| ItemTradeoff | 两条路线、前提、代价、改选条件 | 先问经济/威胁缺口 |
| DecisionFork | 选分支、补假设、撤销 | 不计算无依据的增益 |
| TrainingDrill | 先提交、再讲解、换变体 | 明确教学情境 |
| EvidenceLens | 事实字段、时刻、缺口 | 局部错误 |
| KnowledgeLens | 英雄/技能/物品的情境知识 | 暂无资料/局部重试 |
| PracticeCommit | 保存、检查、完成、撤销 | 本机会话状态 |

当前运行时只是目录和版本守卫的最小实现。原型部分页面为可信应用模板，只有决策面板演示受控 patch；不声称九个生产级 Agent widget 均已实现。

## 内部事件契约（生产设计目标）

```ts
type Authority = 'fact' | 'inference' | 'user_report' | 'hypothesis' | 'demo';
interface CoachContext {
  sessionId: string;
  contextId: string;
  contextRevision: number;
  mode: 'review' | 'draft' | 'practice';
  subject: { matchId?: number; playerSlot?: number; heroId?: number };
  source: 'live_facts' | 'teaching_demo';
}
interface DomainEvent {
  eventId: string;
  sessionId: string;
  contextId: string;
  contextRevision: number;
  surfaceId: string;
  expectedSurfaceRevision: number;
  action: 'answer' | 'compare' | 'inspect' | 'save' | 'selectHero' | 'annotate' | 'retry';
  payload: Record<string, unknown>; // 再按 action 专属 schema 校验
}
interface DomainPatch {
  requestId: string;
  runId: number;
  contextId: string;
  contextRevision: number;
  surfaceId: string;
  expectedRevision: number;
  revision: number;
  update: unknown; // 再按组件目录 schema 校验
}
```

影响判断的输入变化才递增 contextRevision；打开资料、滚动、选中编辑格不递增。事实快照只读，假设分支独立。

生产动作须绑定 surfaceId 和 expectedSurfaceRevision。原型 answerEvent 只检查 context/eventId，是精简示例，不能直接作为生产安全边界。服务端再次检查权限、快照、事实归属与幂等。

## 闭环示例

“为什么这波团没打好” → 读取 MatchFact 并检查能力 → 展示 CoachBrief 和有依据的节点 → 问一个会改变判断的问题 → 玩家点记不清 → answer 事件将补充标为 user_report → 更新同一 DecisionFork → 比较等队友先手的 hypothesis → 玩家显式保存 PracticeCommit。

不重新追加整份报告，不修改原事实，不自动操作游戏。原型比较按钮用固定教学模板演示 beginRun/applyPatch/finishRun；没有调用远端模型。

## 证据与空间安全

证据建议字段：evidenceId、source、factPath、matchId、playerSlot、timeRange、fetchedAt、completeness，以服务实际提供为准。现有 ReviewEvidence.factKey 是起点，必须服务端解析、确认字段存在、属于当前比赛且时间窗适用；只校验路径格式不够。

grounded=true 不是每一句因果判断正确。事实、推断、用户回忆、假设、演示分开。用户说有某物品不能自动改写事实。

统计不能生造坐标；分路聚类不能生造某个时刻的位置；没有视野不能说玩家看见/没看见；没有冷却不能说技能交过；经济领先不能推出单场校准胜率。

## 生命周期与安全

同时检查 contextId/contextRevision/runId/surface revision。仅当前请求可更新，版本连续；重复包丢弃，缺包重同步；cancel 保留完成内容并使旧包失效。

组件和动作双白名单。禁止 RawHtml、eval、动态脚本、任意 CSS、危险 URL scheme。图片使用可信资源服务；链接经过 HTTPS 与域名策略校验并设置 noopener/noreferrer。用户/模型文本按文本渲染。组件数量、递归深度、批量大小受限。

建议初始预算：单 surface 最多 30 节点、深度 6、单批 64KB、每任务一个生成请求；需真实性能测试校准，不称为已验收容量。

未知组件安全文本回退；旧 Markdown 保留兼容，但不伪装已生成装备或路线。网络失败保留事实/草稿并重试原任务；模型不可用时资料与事实仍可看。
