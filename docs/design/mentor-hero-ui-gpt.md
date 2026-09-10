# Mentor Hero UI 设计说明（GPT 草案）

## 1. 背景与目标

当前 `AI 教练` 页面空状态更像“通用聊天入口”，没有建立 **“英雄是导师，用户是学生”** 的产品关系，也没有把后续能力组织成清晰的学习路径。现有空状态的主要问题：

- 视觉焦点过于像通用对话框，不像“选择导师英雄后开始学一名英雄”
- 默认问题与主操作脱节，用户不知道下一步应该先选英雄还是直接提问
- 空状态没有承接后续能力（BP / 对局 / 出装 / 思路 / 复盘）
- 继续打磨“泛聊天空页面”会把产品往错误方向带偏

本设计文档的目标不是继续美化聊天壳，而是将 `AI 教练` 重定义为 **Mentor Hero（导师英雄）学习界面**：

- **核心隐喻**：Dota 2 英雄是导师 / 教练，用户是来学习的学生
- **核心任务**：先选导师英雄，再进入具体学习模式
- **核心输出**：围绕 BP、对局、出装、思路的 AI 讲解与分析
- **延后能力**：VOD / replay 复盘仅保留信息架构占位，暂不进入 P0 / P1 交互主线

---

## 2. 产品信息架构（IA）

### 2.1 一级结构

`AI 教练` 页应改造为以下信息架构：

1. **选择导师英雄**
2. **进入课程模式**
   - BP（Ban / Pick）
   - 对局
   - 出装
   - 思路
   - 复盘（占位）
3. **在对应模式下进行教学对话 / 流式分析**

### 2.2 推荐用户路径

```text
进入 AI 教练
  → 选择导师英雄
    → 选择课程模式
      → 提供上下文（可选）
        → 发起分析 / 对话
          → 持续追问 / 切换模式继续学习
```

### 2.3 结构原则

- **先导师，后问题**：未选导师英雄前，不鼓励直接进入自由聊天
- **先模式，后分析**：分析类型必须显式，让用户知道“这次是在学 BP、对局、出装还是思路”
- **一个页面承接完整学习链路**：不做 coach 页内部的内容轮播，不引入“职业比赛/公众比赛推荐卡片”
- **复盘先占位，不抢主导航**：Replay Review / VOD Review 仅作为未来能力的稳定预告，不提前做复杂入口

### 2.4 IA 草图

```text
AI 教练 / AI Coach
├─ Hero Mentor Header
│  ├─ 当前导师英雄（未选择 / 已选择）
│  └─ 切换导师英雄
├─ Lesson Modes
│  ├─ BP
│  ├─ 对局
│  ├─ 出装
│  ├─ 思路
│  └─ 复盘（Coming later）
├─ Teaching Surface
│  ├─ 空状态
│  ├─ 英雄选择态
│  ├─ 教学对话态
│  └─ 流式分析态
└─ Input Bar
   ├─ 上下文提示
   ├─ 用户输入
   └─ 主 CTA
```

---

## 3. 页面状态与 Screen Map

本节定义 4 个关键页面状态：**空状态 / 选择导师 / 教学聊天 / 分析流式输出**。

### 3.1 Empty State（未选择导师）

#### 目标

让用户在 3 秒内理解：这里不是普通聊天页，而是“先选一名导师英雄，再开始学习”。

#### 页面结构

```text
Top Nav
└─ AI 教练

Hero Mentor Empty State
├─ 小型徽记 / icon
├─ 标题：选择你的导师英雄
├─ 副标题：让一名英雄用自己的视角教你怎么赢
├─ 主 CTA：选择导师英雄
├─ 次级说明：可学习 BP / 对局 / 出装 / 思路
└─ 禁止出现：通用问答推荐列表、比赛卡片轮播、灰色遮罩浮层

Bottom Input
└─ disabled，提示“先选择导师英雄”
```

#### 推荐文案（zh / en）

- 标题：`选择你的导师英雄` / `Choose your mentor hero`
- 副标题：`让一名英雄从自己的视角，教你 BP、对局、出装与思路。` / `Learn BP, matches, item builds, and decision-making from one hero's perspective.`
- 主 CTA：`选择导师英雄` / `Choose mentor hero`
- 输入框占位：`先选择导师英雄，再开始提问` / `Choose a mentor hero before asking`

#### 主 CTA

- **主 CTA = 选择导师英雄**
- 在此状态下，不允许“发送问题”成为首要操作

---

### 3.2 Picking Mentor（选择导师英雄）

#### 目标

把“选英雄”从工具步骤提升为“选导师”的情绪化动作。

#### 页面结构

```text
Mentor Picker Surface
├─ 标题：你想跟谁学习？
├─ 搜索框
├─ 英雄网格
├─ 已选导师预览
└─ 确认按钮：以 {heroName} 作为导师
```

#### 交互规则

- 只允许单选一个导师英雄
- 点击英雄卡后，右侧或顶部显示“导师预览卡”
- 确认前 CTA 不应该写“继续”这种抽象词，应该直接写明动作
- 关闭选择器后返回教学页，并自动进入 lesson mode 选择

#### 推荐文案（zh / en）

- 标题：`你想跟谁学习？` / `Who do you want to learn from?`
- 确认按钮：`以 {英雄名} 作为导师` / `Learn from {Hero}`
- 切换按钮：`更换导师` / `Change mentor`

#### 主 CTA

- 未选择英雄时：**无激活主 CTA**
- 已选择英雄时：**主 CTA = 以 {heroName} 作为导师**

---

### 3.3 Teaching Chat（已选导师，等待提问或模式选择）

#### 目标

进入“老师已就位”的教学关系，让模式比闲聊更靠前。

#### 页面结构

```text
Mentor Hero Page
├─ Mentor Header
│  ├─ 导师英雄头像 / 立绘
│  ├─ 导师名（中文优先）
│  ├─ 一句话导师设定
│  └─ 更换导师
├─ Lesson Mode Tabs / Pills
│  ├─ BP
│  ├─ 对局
│  ├─ 出装
│  ├─ 思路
│  └─ 复盘（占位）
├─ Conversation Intro
│  ├─ 模式简介
│  └─ 建议提问模板（按模式变化）
└─ Input Composer
   ├─ 上下文 chips（可选）
   ├─ 输入框
   └─ 主 CTA：开始分析 / 开始讲解
```

#### 交互规则

- 选定导师后，默认自动聚焦到 **Lesson Mode**
- 默认模式建议为 **对局**，因为最接近用户的即时学习需求
- 模式切换会改变：
  - 顶部模式说明
  - 输入框 placeholder
  - 建议追问模板
  - 主 CTA 文案
- 不展示“职业比赛/公众比赛轮播”
- 可展示简短的 OpenDota 数据来源标识，但不要遮罩在内容上方

#### 推荐文案（zh / en）

- 导师说明：`{英雄名} 将作为你的导师，从他的视角带你理解如何赢。` / `{Hero} will mentor you through how this hero wins.`
- 模式说明示例：
  - BP：`学习这名英雄怕什么、搭什么、何时该拿。` / `Learn when to pick this hero, what it fears, and what it pairs with.`
  - 对局：`分析当前对线与整体对局应该怎么打。` / `Analyze how to approach this matchup and game flow.`
  - 出装：`理解这名英雄的核心装、节奏装与应对装。` / `Understand core, tempo, and situational itemization.`
  - 思路：`不是背答案，而是学习这名英雄的判断框架。` / `Learn the decision framework, not just answers.`
  - 复盘：`复盘能力规划中，后续支持上传回放或 VOD。` / `Replay review is planned for a later release.`

#### 各模式主 CTA

- BP：**分析这局 BP**
- 对局：**分析这局对线 / 对局**
- 出装：**分析出装思路**
- 思路：**讲解打法思路**
- 复盘：**查看复盘规划**（非真正执行分析）

---

### 3.4 Analysis Streaming（流式分析输出中）

#### 目标

让用户感受到“导师正在讲解”，而不是“LLM 正在生成文本”。

#### 页面结构

```text
Streaming State
├─ Mentor Header（固定）
├─ Active Lesson Mode（固定）
├─ Conversation Timeline
│  ├─ 用户问题
│  ├─ 导师分析卡（streaming）
│  └─ 数据来源提示（OpenDota grounded）
└─ Composer
   ├─ 处理中状态
   ├─ 停止 / 重试
   └─ 追问入口
```

#### 交互规则

- streaming 内容的视觉焦点是 **导师回答本身**
- loading 文案尽量人格化，但不要过度拟人或戏谑
- 必须能明确区分：
  - 用户输入
  - 导师讲解
  - 结构化数据卡（如 BP 要点、出装树、对线风险）
- 如果引用公开数据，应在内容区底部以轻量方式标注：
  - `基于 OpenDota 公开数据`
  - `Grounded with OpenDota public data`
- 禁止使用灰色蒙层遮盖内容区，避免“不可读、未完成”的廉价感

#### 主 CTA

- streaming 中：**停止生成**
- streaming 结束后：**继续追问**

---

## 4. 组件层级与交互规则

本节定义推荐组件层级，便于后续只围绕核心心智重构，不再继续叠加空状态装饰。

### 4.1 顶层层级

```text
CoachPage
├─ CoachTopNav
├─ MentorHeroShell
│  ├─ MentorHeader
│  ├─ LessonModeSwitcher
│  ├─ TeachingCanvas
│  │  ├─ MentorEmptyState
│  │  ├─ MentorPickerPanel
│  │  ├─ TeachingConversation
│  │  └─ StreamingAnalysisBlock
│  └─ MentorComposer
└─ Optional Side Sheet / Modal
   └─ HeroPicker
```

### 4.2 关键组件说明

#### MentorHeader

- 职责：持续声明“当前是谁在教你”
- 内容：
  - 英雄头像 / 立绘
  - 英雄中文名 + 英文名
  - 模式标签
  - 更换导师入口

#### LessonModeSwitcher

- 职责：显式切换本次学习目标
- 推荐形式：横向 tabs 或 pills
- 不建议做成下拉菜单；模式是一级结构，不应被隐藏

#### TeachingCanvas

- 职责：承载状态变化
- 只在一个主区域里切换四种状态：
  - 空状态
  - 选导师
  - 教学聊天
  - 流式分析

#### MentorComposer

- 职责：承接输入与主 CTA
- 应根据状态变化：
  - 未选导师：禁用
  - 已选导师未选模式：引导先选模式
  - 已选模式可输入：启用主 CTA
  - streaming 中：切为停止 / 重试逻辑

### 4.3 主 CTA 规则总表

| 状态 | 主 CTA | 是否可用 | 说明 |
|---|---|---:|---|
| 未选择导师 | 选择导师英雄 | 是 | 全页唯一主动作 |
| 导师选择中（未选） | 无 | 否 | 避免误触继续 |
| 导师选择中（已选） | 以 {heroName} 作为导师 | 是 | 明确确认关系 |
| 已选导师，未分析 | 按当前模式发起分析 | 是 | 文案随模式变化 |
| 分析 streaming 中 | 停止生成 | 是 | 主动作转为过程控制 |
| 分析完成 | 继续追问 | 是 | 维持学习连续性 |
| 复盘占位 | 查看复盘规划 | 是 | 仅展示方向，不进入真实功能 |

### 4.4 输入与模式联动规则

- 输入框 placeholder 必须跟随模式变化，而不是固定“输入其他问题”
- 建议占位文案：
  - BP：`例如：这局先手拿 {英雄名} 合适吗？`  
    `e.g. Is {Hero} a good first-phase pick here?`
  - 对局：`例如：这局对线期我最该注意什么？`  
    `e.g. What should I focus on in lane?`
  - 出装：`例如：这局第一件关键装应该做什么？`  
    `e.g. What is the first key item this game?`
  - 思路：`例如：这名英雄中期该怎么判断进退？`  
    `e.g. How should this hero decide fights in mid game?`
- 输入框下方可以保留 2–3 个建议问题，但它们必须是 **课程提示**，不是泛聊天推荐

---

## 5. Visual System v2 Tokens

### 5.1 视觉方向

视觉基调必须服务“黑暗、克制、导师感”，而不是电竞荧光风。

- **Dark monochrome first**
- **中文优先的静态排版**
- **白色反相 CTA 作为唯一明显强调**
- 不使用荧光黄绿，不使用夸张渐变，不使用半透明灰遮罩盖住主要内容

### 5.2 颜色 Tokens

> 约束：**禁止使用 lime `#D8FF3E`**  
> 主 CTA 使用 **反相白 `#F5F5F5` / `#0B0B0C`**

#### Foundations

- `bg.canvas = #0B0B0C`
- `bg.surface = #111214`
- `bg.surface-elevated = #16181B`
- `bg.surface-pressed = #1B1D21`
- `border.default = rgba(255,255,255,0.08)`
- `border.strong = rgba(255,255,255,0.14)`
- `text.primary = #F5F5F5`
- `text.secondary = rgba(245,245,245,0.72)`
- `text.tertiary = rgba(245,245,245,0.46)`
- `text.disabled = rgba(245,245,245,0.28)`
- `accent.inverse-bg = #F5F5F5`
- `accent.inverse-fg = #0B0B0C`
- `accent.soft = rgba(255,255,255,0.06)`
- `state.streaming = rgba(255,255,255,0.88)`

#### Data / Grounding

- `grounding.label = rgba(255,255,255,0.54)`
- `grounding.rule = rgba(255,255,255,0.10)`

### 5.3 字体与排版

- 中文优先，英文作为辅文
- 标题层级尽量少，避免满屏 marketing 感
- 建议层级：
  - `display-sm`: 页面主标题 / 空状态标题
  - `title-md`: 导师名、模式标题
  - `body-md`: 主内容
  - `body-sm`: grounding、辅助说明

### 5.4 圆角、间距、阴影

- `radius.card = 16px`
- `radius.button = 14px`
- `radius.pill = 999px`
- `spacing.base = 4px`
- `card.padding = 20–24px`
- 阴影尽量轻，主要靠层级与边框区分，不靠发光效果

### 5.5 按钮规范

#### Primary CTA

- 背景：`#F5F5F5`
- 文字：`#0B0B0C`
- hover：轻微降亮，不增加彩色描边

#### Secondary CTA

- 背景：透明或浅白叠层
- 边框：`border.default`
- 文字：`text.primary`

### 5.6 模式标签 / pills

- 未选中：深底 + 浅边框
- 选中：不使用荧光色块，使用更亮的 monochrome 反差
- hover：只提升边框与文字亮度

---

## 6. P0 / P1 / Later 规划

### 6.1 P0（本轮设计应覆盖）

- 将 `AI 教练` 明确重构为 **Mentor Hero 学习页**
- 先选导师英雄，再进入教学模式
- 定义 4 个主状态：
  - 空状态
  - 选择导师
  - 教学聊天
  - 流式分析
- 提供 4 个核心 lesson modes：
  - BP
  - 对局
  - 出装
  - 思路
- 建立中文优先、英文辅助的文案框架
- 明确 OpenDota public API grounding 的展示原则

### 6.2 P1（下一阶段可做）

- 为不同英雄补充一句话“导师设定”
- 为不同模式补充结构化回答模板
  - BP：克制 / 搭配 / 拿点时机
  - 对局：对线、节奏、团战
  - 出装：核心装、局势装、替代装
  - 思路：胜利条件、站位、资源交换
- 支持保存最近学习过的导师英雄
- 更细的 OpenDota 数据来源文案与引用块

### 6.3 Later（明确延后）

- **VOD / Replay Review**
  - 上传 replay
  - 上传视频片段
  - 时间轴批注
  - 关键失误定位
- 跨导师多英雄对比学习
- 长周期成长档案 / 学习进度

> `复盘` 在本轮只保留 IA 占位，不应伪装成已上线能力。

---

## 7. 明确反模式（Anti-patterns）

以下内容应在设计与后续实现中明确避免：

### 7.1 泛聊天空状态打磨

- 不继续围绕“像 ChatGPT 一样的空白聊天页”做 polish
- 不把推荐问题列表当作主体内容
- 不让输入框成为未选导师时的视觉主角

### 7.2 视觉反模式

- 不使用 `#D8FF3E`
- 不使用荧光电竞绿作为主强调色
- 不使用大面积灰色遮罩 / 毛玻璃灰蒙层压住内容
- 不使用过多渐变、发光描边、赛博风装饰

### 7.3 信息架构反模式

- 不在 coach 页加入 **职业比赛 / 公众比赛 carousel**
- 不把 BP / 对局 / 出装 / 思路藏进二级菜单
- 不让 `复盘` 冒充 P0 功能
- 不把“英雄百科”式浏览体验直接复制到“AI 教练”

### 7.4 数据来源反模式

- 不使用 Dotabuff scraping
- 不做来源不明的“灰色覆盖层提示”
- 不把 grounding 做成打断阅读的硬提示
- 必须以 **OpenDota public API** 作为公开数据基础

### 7.5 交互反模式

- 未选择导师前，不应把“发送问题”作为 primary CTA
- 已选择导师后，不应继续停留在 generic empty state
- streaming 中，不应让用户看不出“当前模式”与“当前导师”

---

## 8. 一句话结论

`AI 教练` 不应再被当作“聊天页”，而应被定义为 **一名英雄作为导师，围绕具体 lesson mode 教用户变强的学习界面**。  
因此后续 UI 工作应围绕 **导师英雄 → 学习模式 → 流式讲解** 这条主线展开，而不是继续优化泛化空状态。
