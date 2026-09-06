# 英雄导师 UI 设计综述（Mentor Hero UI Synthesis）

> **状态**：P0 实现规范（综合 GPT/Kimi/Grok 三份设计提案）  
> **范围**：`AI 教练` Tab 的信息架构与空状态重构  
> **核心隐喻**：**英雄 = 导师，用户 = 学员**

---

## 1. 核心产品决策（P0 锁定）

### 1.1 空态 = 导师空位 + 请人

- **空态标题**：「今天谁教你。」
- **唯一主 CTA**：反白按钮「请出导师」→ 打开 MentorPicker
- **没有**：sparkle 徽章、宽 pill 建议条、职业/高分比赛轮播、反白「选双方英雄」大按钮
- **弱出口**：文字链「先看版本谁强」（meta）
- **降级 Composer**：占位「问一句也可以，但先请导师会准得多」

### 1.2 选导师 = 单选一位英雄

- 复用英雄网格（`HeroPickerOverlay` 过滤逻辑）
- **单选**：点第二位即替换第一位，不进双侧草稿
- **无天辉/夜魇切换**：阵容归属课时 `bp` / `match`，另开「补阵容」
- 点英雄即落座并关层

### 1.3 课时条（LessonRail）

选定导师后，主交互变为课时条：

| 模式 id | 中文 | English | 说明 | 分期 |
|---------|------|---------|------|------|
| `bp` | BP | Ban/Pick | 以该英雄视角看选人、反选、站位 → 映射 `analyze` + `suggest` | P0 |
| `match` | 对局 | This game | 这把怎么打：节奏、对线、团战站位 → 映射 `playbook` | P0 |
| `items` | 出装 | Items | 出门/前中后期件；对这套阵容怎么改 | P0 |
| `mind` | 思路 | Game sense | 决策顺序：何时打、何时怂、技能交换 | P0 |
| `review` | 复盘 | Replay | **禁用占位**，以后用 OpenDota match ID，不爬 Dotabuff | Later |

### 1.4 阵容 = 课时上下文，非入场券

- 阵容条（`DraftContextChip`）降为课时道具
- 空态时不以「选择双方英雄」作为主 CTA
- BP / 对局课可先开课，导师提示补阵容

### 1.5 导师人格

- **消息头**：导师头像 + 英雄名
- **流式思考**：「{英雄名}在看数据」，不是「AI 教练正在思考」
- **口吻**：短、尖、敢下判断，用数据撑，不装全知

---

## 2. 屏幕状态

```
Empty (无导师) → PickingMentor → LessonReady → TeachingChat ↔ AnalysisStreaming
```

### 2.1 Empty — 无导师

- 导师空位肖像框（96×96，`surface` 底 + 细边框）
- 标题「今天谁教你。」
- 唯一主 CTA「请出导师 ›」
- 弱出口「先看版本谁强」
- 降级 Composer

### 2.2 PickingMentor — 选导师

- 标题「请出导师」
- 单选网格
- 点选即落座关层

### 2.3 LessonReady — 有导师、尚未开口

- 导师席：头像 + 名 + 坐下台词
- 课时条：五个模式，复盘禁用
- 阵容条（可选补）
- Composer：「直接问 {英雄}，或选一堂课」

### 2.4 TeachingChat — 授课对话

- 导师消息：头像 + 英雄名 + 课时标签
- `grounded` 徽章：「基于 OpenDota 数据」或「判断，数据未验证」
- 课时条切换（当前课反白字重或描边）

### 2.5 AnalysisStreaming — 流式分析

- 主 CTA：「停止」
- 发送键禁用
- 思考：「{英雄名}在看数据」

---

## 3. 视觉硬约束

| 约束 | 说明 |
|------|------|
| 暗色单色 | 继承 k3 token；**禁止 lime `#D8FF3E`** |
| 主 CTA 反白 | `bg #F5F5F5` / `text #0B0B0C` |
| 教练页无比赛轮播 | `ProMatchStrip` 不进入 CoachView |
| 数据接地 | 仅 OpenDota 公开 API；无数据写「暂无数据」，**不用灰遮罩** |
| 中文优先 | 界面默认 zh，en 为切换态 |

---

## 4. 组件映射

| 现有组件 | v2 归属 |
|----------|---------|
| `WelcomeState` | → `MentorStage`（空态 + LessonReady） |
| `HeroPickerOverlay` | → `MentorPicker`（单选导师模式） |
| `IntentChips` | → `LessonRail`（课时条） |
| `ChatMessage` | 增加导师人格渲染 |
| `DraftContextChip` | 降为课时道具 |

---

## 5. 文案表（P0）

| key | 中文 | English |
|-----|------|---------|
| `empty.title` | 今天谁教你。 | Who is teaching you today. |
| `empty.cta` | 请出导师 | Call your mentor |
| `empty.metaLink` | 先看版本谁强 | Check the patch first |
| `empty.input` | 问一句也可以，但先请导师会准得多 | You can type, but a mentor will be sharper |
| `picker.title` | 请出导师 | Call your mentor |
| `seat.tagline` | 坐下了。选一堂课，或直接问我。 | I'm here. Pick a lesson, or just ask. |
| `lesson.bp` | BP | Ban/Pick |
| `lesson.match` | 对局 | This game |
| `lesson.items` | 出装 | Items |
| `lesson.mind` | 思路 | Game sense |
| `lesson.review` | 复盘 | Replay |
| `lesson.reviewHint` | 复盘还没开课。以后用 OpenDota 比赛 ID。 | Replay review is not open yet. |
| `stream.thinking` | {hero}在看数据 | {hero} is reading the numbers |
| `stream.stop` | 停止 | Stop |
| `badge.opendota` | 基于 OpenDota 数据 | Grounded in OpenDota |
| `badge.unverified` | 判断，数据未验证 | Judgment, unverified |

---

## 6. 反模式（禁止）

1. 继续打磨通用聊天空态（sparkle + 建议 pill）
2. 把阵容挑选当成第一课（空态主 CTA 是「选双方英雄」）
3. 教练页挂职业/高分比赛轮播
4. 用灰罩 / 截图冒充数据
5. 品牌色回潮（lime `#D8FF3E`）
6. 无菌问答机器人口吻
7. 编造刀塔数值/版本结论
8. 一屏多颗主 CTA
9. 复盘装已上线
10. 英文当默认

---

## 7. 成功标准

1. 空屏读作「先请导师」，而不是「又一个 AI 聊天框」
2. 课时是 BP / 对局 / 出装 / 思路，复盘明确占位
3. 每一态只有一颗反白主 CTA，无比赛轮播、无 lime、无灰罩假数据
4. 导师说话像主这个英雄的人，而不是无菌 Q&A
