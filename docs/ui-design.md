# codar-bot UI 交互设计 v1.0

| | |
|---|---|
| 日期 | 2026-11-05 |
| 状态 | draft，待 Felix 评审（评审后作为 M2 前端实现契约） |
| 输入 | Grok Bot 布局调研（官方文档 + 官网 DOM 还原 + HN 口碑，2026-11-05）；M1 已实现系统行为；M1-E review 遗留 P3 |
| 交付 | 本文档 + `mockups/group-chat.html` 可点击双语原型 |
| 决策记录 | 布局参照 Grok Bot 三区形态（Felix 指定调研）；首版双语 en/zh（Felix 拍板）；文档+HTML 原型（Felix 拍板） |

---

## 0. 设计原则（从调研提炼）

1. **花名册即收件箱**：不做「管理页+聊天页」分离。侧栏每行 = 一个 Bot/群 + 最近状态一句话。
   Grok Bot 用此隐喻让「管理团队」退化为「看消息」。
2. **一切皆内嵌卡**：执行进度、派活、审批、预算事件都是聊天流里的卡，不是弹窗/独立页。
   留在 transcript 里 = 天然可回溯（契合 append-only 审计）。
3. **进度用清单消息，不用加载动画**：`✓ 工具 → 结果` 既当实时进度又当事后摘要。
4. **回合制必须显式可见**（差异化）：Grok Bot 无回合指示，HN 最大吐槽是 Bot 噪音与
   token 烧钱——我们的显式回合 + 预算正是解药，UI 要把「现在轮到谁/谁在干活」
   做成一等公民。
5. **审批三按钮 + 规则沉淀**：Allow once / Always allow(存规则) / Deny 是最小完备集
   （Grok Bot 验证过的形态）。
6. **不可逆动作默认 draft 等审批**（Grok Bot 银行数据事故的直接教训）。
7. **诚实状态**：not-isolated 沙箱、budget 兜底为 token 型、provider 未配置——
   永远显示真实状态，不装作没问题。

## 1. 信息架构：从「三 Tab」到「三区工作站」

M1 的 Overview/Chat/Usage 三 Tab 废弃，改为常驻三区（Grok Bot 同构 + 右栏换血）：

```
┌─ codar ──────────────────────────────────────── [en|zh] ─┐
├──────────────┬────────────────────────────┬──────────────┤
│ ROSTER 侧栏  │  CHAT 当前会话             │ CONTEXT 右栏 │
│ (收件箱隐喻) │  (单列时间线+内嵌卡)       │ (可折叠)     │
│              │                            │              │
│ ● Chief      │  会话头：群名/成员/模式    │  TURN 状态   │
│   14:02 ✓已  │  ─────────────────────    │  Chief ⚪    │
│   派活给Wr   │  (消息与卡片流)            │  Writer ⏱2m │
│ ● Writer     │                            │  Research⚪  │
│   ⏱ 起草中…  │                            │ ──────────  │
│ ● Research   │                            │  WORKS 工作树│
│   ○ idle     │  ┌ composer ─────────┐    │  ▶ w1→Writer│
│ ◎ default 群 │  │ @ 提及/消息… [➤]  │    │  ✓ w0→Chief │
│   (堆叠头像) │  └───────────────────┘    │ ──────────  │
│ + New bot/群 │                            │  BUDGET     │
│ ──────────  │                            │  Writer▓▓░71%│
│ ⚙ Settings  │                            │  群▓▓▓▓░43% │
└──────────────┴────────────────────────────┴──────────────┘
```

- **移动端**（P2 前仅保证可用）：侧栏抽屉化，右栏折叠为聊天流顶部的紧凑条
  （turn 状态 + 预算警示），横向滑动展开。
- **右栏为什么不是「电脑画面」**：Grok Bot 右栏是共享电脑直播；我们的 M2 语义是
  Docker workDir 而非可视化屏幕。右栏放**回合/工作树/预算**三面板——把我们的
  差异化做成常驻可见，而不是藏在页面里。workDir 文件预览（M3+）可后补为右栏第四面板。

## 2. Roster 侧栏（收件箱）

每行四要素 + 三态（Grok Bot 模式）：

```
● 头像  名字            时间
        最近状态一句话（最后事件/消息预览，截断）
```

- **三态徽章**（行级，比未读计数信息量大）：
  - 🔴 needs-attention：等待审批 / 派活结果待确认 / 失败需要人
  - 🔵 unread：有新结果未读
  - ⏱ working：正在干活（带 elapsed）
- 群聊行：**堆叠头像**区分；预览行显示群内最近一句话。
- 行右键菜单：start/stop/delete/rename/set model/set budget。
- 排序：attention > working > 最近事件时间。
- 空状态（首次启动）：引导三步——`codar init` 提示、选 provider、创建 Chief
  （把 §3.2 bootstrap 搬进 UI，M2 落地）。

## 3. Chat 聊天流——卡片词汇表

### 3.1 消息泡（基础单元）

- 用户：右对齐强调色，无头像。
- Bot：左对齐，**头像+名字+模型小字**（模型可换的提示常驻），流式时尾随 ▍，
  message_end 后固化；工具调用期间显示内联 `⚙ tool…` 折叠行。
- 系统行：居中小字灰线（`── Messages from @Writer ──` 交接行可点跳转，
  Grok Bot 验证的低成本协作可视化）。

### 3.2 Turn 状态条（差异化核心，Grok Bot 没有）

置于 composer 上方常驻（不占消息流），群聊显示：

```
┌ TURN ────────────────────────────────┐
│ Chief ▶speaking   Writer ⏱working(2m)│
│ Research ⏸waiting   [模式: admin应答] │
└──────────────────────────────────────┘
```

- 每 slot：头像 + 名 + 状态色点（waiting/speaking/posted/passed/working/failed/
  timed-out ——架构 §6.1 状态机一一对应）。
- 空闲乒乓暂停时整条变琥珀色：`⏸ paused — bots idle-talked 4 turns, waiting
  for you`（PRD 3.3-1 反场景的直接呈现）。
- 单聊（单成员 room）不显示此条。

### 3.3 Handoff 派活卡

```
┌─ task #w1 → Writer ────────── ⏱ 2m14s ─┐
│ ✍ 起草周报第一段：Q3 数据已拉齐…        │  ← 一句话实时进度
│ [工作树: Chief→w0✓ → w1▶]               │
└─────────────────────────────────────────┘
→ 完成后原地变为：
┌─ task #w1 ✓ done → Writer (3m02s) ──────┐
│ 周报草稿 v1 已存 ~/shared/weekly-draft.md│
│ 消耗 ¥0.041 · 结果已回群，Chief 已接续   │
└─────────────────────────────────────────┘
```

- 进度实时更新（`tool_execution_update` 事件注入群上下文的同一句话）。
- 卡片可点展开工作树全貌（parent/child/request_id/防环拒绝记录）。
- 排队卡（pending）：`⌛ #w2 → Research (queued) — 等 Research 完成 #w1 的核对`
  （无计时）。
- 失败终态卡 ×2（works 五态全覆盖，评审 R2 补入契约）：

```
┌─ task #w3 ✗ failed → Writer (1m40s) ────┐
│ 原因: provider 500 ×3（auto-retry 耗尽） │
│ [重派] [放弃]                            │
└─────────────────────────────────────────┘
┌─ task #w4 ✗ failed → Research ──────────┐
│ 原因: host-restart（主机重启，不猜状态）  │
└─────────────────────────────────────────┘
```

- 防环拒绝也是卡：`⛔ #w5 rejected — Writer 正在等 Research 的结果，不能反过来
  派活（环）`。

### 3.4 预算事件卡

- 80% 预警：右栏 BUDGET 面板行变琥珀 + 聊天流一条细系统行。
- **群级停机卡与 Bot 级不同形**（§5.3 语义差异：群停=暂停收活不销毁）：
  标题 `⛔ ROOM PAUSED — budget exhausted`，正文列全体 working 成员被中止，
  按钮 `[调整预算恢复] [保持暂停]`，群 composer 禁用置灰。
- 停机广播（PRD 3.2-4，拒绝静默失败）：

```
┌─ ⛔ BUDGET STOPPED — Writer ────────────┐
│ 月度预算已耗尽：¥20.00 / ¥20.00          │
│ [调整预算] [仅本次继续] [保持停机]        │
└─────────────────────────────────────────┘
```

- 自定义端点 cost=0 时：卡上诚实标注 `token 预算兜底（该 provider 未计价）`。

### 3.5 审批卡（M2 交付简版 Allow/Deny，M3 完整形态）

```
┌─ 🔐 Writer wants to write ─────────────┐
│ ~/shared/weekly-draft.md (2.1 KB)      │
│ [Allow once] [Always allow →] [Deny]   │
└─────────────────────────────────────────┘
```

- **M2 简版**（架构 §5.4 M1/M2 默认档的 Web 解法，评审 R1 修正）：可点击的
  `Allow / Deny` 两键内联卡（调 §7 `POST /api/approvals/:id/resolve`），
  `Always allow →` 以置灰 M3 预告位呈现。M1 期审批挂起以只读「挂起中」系统行
  呈现（M1 只在 CLI/spike 场景触发写类 gate）。
- **M3 完整形态**：「Always allow →」落规则（按 Bot/工具/路径粒度）；规则命中时
  聊天流只留一行审计摘要；**全键盘流**（A/D/1-9，PRD M3-3.1）；规则表管理页。
- 审批挂起时 roster 行 🔴 needs-attention、turn 条该 Bot 显示 🔐。

### 3.6 交付物卡（M2 简版）

写文件结果以文件 chip 呈现（路径 + 大小），点击预览（右栏临时面板）。

## 4. Composer（输入区）

- `@` 弹 Bot 补全（键盘 1-9 选择）；`@all` 仅 admin 可发（PRD §5）。
- Enter 发送 / Shift+Enter 换行；流式期间 Enter 询问确认（或直接入队 steer——
  M2 实现时按 pi steering 语义定，默认入队并显示 queued 徽章）。
- 右侧按钮组：➤ 发送 | ■ 停止（流式时替换为停止）| 📎 附文件（P2）。
- composer 上方细错误条（SSE failure 事件落点），自动消失可回放。

## 5. Context 右栏

- **TURN**：同 3.2（与聊天流内条目同源，宽屏显示更全的 slots）。
- **WORKS**：房间工作树列表（queued/进行中▶/完成✓/失败✗/被拒⛔，elapsed，
  点击跳聊天流对应卡）——五态与 §4 works.status 一一对应。空态：`no active
  works in this room`。
- **BUDGET**：每 Bot/群一行 meter：`Writer ▓▓▓░ 71% · ¥14.2/20.0`；hover 展开
  token 明细（input/output/cacheRead）+ 预算四维度（maxTurns 剩余回合数/
  maxWallMs 单任务墙钟）；月度窗口标注；未计价 provider 标注 token 型；
  meter 变色阈值 80% 琥珀 / 100% 红。
- **Bot 详情 = 右栏第二视图**（评审 R1 补）：roster 行点击/右键 → 右栏切换为
  BOT DETAIL：模型/effort（可改，PATCH）、预算四维度（maxTokens/maxCostMicros/
  maxTurns/maxWallMs，hover 见 §5 说明）、沙箱徽章（docker / host·not-isolated
  ——诚实标注）、session 路径、记忆入口（M2-2.3 后）；顶部 `← room` 返回。
  聊天流不动——详情永远不打断会话。
- **面板可折叠**；窄屏退化为顶部紧凑条；roster 右键菜单在触屏为长按。

## 6. SSE → UI 事件映射（实现契约）

| SSE 事件（架构 §7 词汇 / M1 现实现） | payload 关键字段 | UI 落点 |
|---|---|---|
| `message`(status) | botId,status,detail | roster 行徽章 / turn 条 slot 色点 |
| `message`(delta) *M1 impl* | botId,text | 当前流式泡追加 ▍ |
| `message`(assistant) | botId,role,text | 泡固化（文本 dedupe：以 message_end 为准，响应文本仅补洞）|
| `message`(failure) *M1 impl* | botId,reason | composer 错误条 + roster 🔴 + turn 条 failed |
| `message`(aborted) *M1 impl* | botId | 流式泡冻结 + 系统行 `⏹ stopped by you` |
| `progress` *M2* | workId,botId,oneLiner,**status**(queued/working/done/failed/rejected) | 派活卡进度行与终态迁移 + roster 预览 + WORKS 面板行 |
| `message`(handoff 系统行) *M2* | from[],workId | `── messages from @A ──` 交接行（可点跳）|
| `budget` *M2* | scope,spent,limit / stopped | meter 更新 / 预警细行 / 停机广播卡 / 群 paused |
| `approval` *M2 简版* | id,bot,tool,input | 审批卡（Allow/Deny）+ roster 🔴 + 🔐 |
| `system` *M2* | kind,detail | 群广播/乒乓暂停/生命周期系统行 |

（M1 现实现的事件名 status/delta/message/failure/aborted 在 M2 统一收编进
架构 §7 的五类：`message` 携带 subtype。前端按本表映射，避免两套词汇。）

重连语义：EventSource 重连后以 `GET messages` 差量补齐（Last-Event-ID 机制 M2
后评估）；断线条常驻「reconnecting…」直到 hello。

## 7. 状态完备表（每屏必须有：空/加载/错误/权限）

- 首启空态：init 引导（见 §2）。
- Bot stopped：聊天流禁用 + 顶部 `Bot 已停机 [Start]`。
- Provider 未配置：建 Bot 表单内联红字 + `codar init` 指引复制按钮。
- 群 paused（预算/乒乓）：composer 禁用 + 原因卡置顶。
- 沙箱：Bot 详情显示 `docker` / `host (not-isolated)` 徽章——诚实标注。
- 历史加载：骨架屏 ≤300ms 才显示（避免闪载）。

## 8. 双语（首版即有，Felix 拍板）

- 所有文案走 i18n 字典（`web/src/i18n.ts`，en/zh 两表）；语言切换在顶栏，
  持久化 localStorage；系统事件/卡片文案全部双语键。
- Bot 名字/角色等用户内容不翻译。
- 时间/金额格式随 locale（zh: ¥0.041；en: CNY 0.041——币种中性原则见架构 §4；
  所有字典值不得硬编码货币符号跨语言复用）。

## 9. M1 遗留 P3 的吸收（重做聊天组件时一并解决）

空回复 dedupe、streaming 残标、切 bot 陈旧闭包、Enter 无流式闸、状态水化——
全部转为本设计的验收标准（§6 映射 + §10 清单）。

## 10. 原型验收清单（mockups/group-chat.html 必须演示）

1. 三区布局 + roster 三态行（attention 置顶、unread 实例）+ 群聊堆叠头像
2. 流式消息（逐字打出 + ■ 停止流式）
3. Turn 状态条：常态（speaking/working/🔐approval）与乒乓暂停态（按钮切换、暂停禁用 composer）
4. 派活卡全生命周期：queued → 进行中(计时) → done(消耗/回流) → failed×2(重试耗尽/host-restart) → rejected(防环)
5. 预算停机广播卡（Bot 级 + 群级两形）+ 右栏 meter
6. 审批卡 M2 简版：Allow/Deny 可点（原型内假 resolve：卡原地变 ✓/⛔、Research 的 attention/🔐 解除），Always allow 置灰 M3 预告
7. 双语切换 en↔zh 全量生效（金额随 locale）
8. 交接系统行可点跳转（跳到对应 Bot 消息）
9. 右栏 Bot 详情视图（沙箱诚实徽章/预算四维度 hover）与文件预览

## 11. 差异化定位声明（写给未来 README 的用户）

Grok Bot 验证了「Bot 团队+聊天」形态，但：无回合制（噪音/烧钱吐槽）、审批疲劳、
闭源锁栈。codar-bot 的 UI 三件常驻可见物——**Turn 条、Budget meter、审计即
transcript**——每一样都对着它的最强吐槽点。

## 修订记录

- 2026-11-05 v1.0：初稿（Grok Bot 调研输入 + M1 系统事实 + Felix 四项拍板）。
- 2026-11-05 v1.1：评审 R1/R2 修订——works 五态全覆盖（failed×2/pending 入
  §3.3 契约）、M2 简版审批卡、SSE 表三列对齐架构 §7 且 progress 带 status、
  右栏 BOT DETAIL 第二视图、群级停机卡独立形、i18n 全量与币种随 locale。
