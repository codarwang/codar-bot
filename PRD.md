# codar-bot — 产品需求文档（PRD）

| | |
|---|---|
| 版本 | v1.2（修订记录见文末） |
| 日期 | 2026-11-04 |
| 作者 | ZCode（代 Felix 起草），调研底稿见附录 |
| 状态 | §15-1/2/3 已拍板（2026-11-04）；§15-4 M0 期内定 provider；§15-5 商标人工查 + an earlier internal project 仓处置待 Felix；域名 codarbot.com 单枚、可选、非阻塞（Felix 自购）；M0 未开工 |
| 品牌资产 | npm 包 `codar-bot`（空闲）· GitHub `codarwang/codar-bot` · CLI `codar` · 数据目录 `~/.codar-bot/` · 主域 codarbot.com（唯一必买项；防御域 codar-bot.com 仅项目起势后选购） |

---

## 0. 一句话

**在 pi 运行时上，给你的 Bot 团队一个家**：单机自托管、模型自带、聊天式多 Bot
协作；预算、审批、审计是同类产品都没有的差异化。

## 1. 背景与机会

### 1.1 三个实证（2026-11 调研，证据见附录）

1. **产品形态已被双重验证**。DS-Bot（npm `ds-bot`，骑 DeepSeek DSH 的多 Bot
   群聊插件）四周 5.5k★/508 fork，证明"自己的机器 + 自己的 key + 聊天式多
   Bot 团队"有真实需求；Cursor/Anysphere 把几乎同形态（Bot + 执行电脑 +
   审批 + 自动审查 + 跨 Host 协作）做成了正式闭源产品（Grok Bot）。
2. **pi 生态这个位子实质空着**。pi（github.com/earendil-works/pi，~120k★，
   MIT，官方定位"minimal extensible harness that you can make your own"）
   **刻意不做 sub-agent 与编排**，把这一层留给生态。现存唯一同类尝试
   `luodaoyi/pi-bot`（DS-Bot 形态向 pi 的移植）：36 个 commit 全部挤在
   10-11/12 两天、此后 3 周+零提交、0★/0 fork、TODO 自曝依赖没装上编译报错
   ——名义有主、实质空位。独立复现反而验证了需求真实。
3. **治理是全生态的空位**。DS-Bot 用量只记账无预算（用户在为群聊费用哀
   嚎）、审批只有 allow-once、无因果审计；pi-bot 预算/审批/审计/Chief 全
   无；ProkBot 审批是闭源黑盒。an earlier internal project 用 5383 个测试钉过的预算结算 /
   审批闸门 / 事件时间线语义，恰是所有对手都缺的东西。

### 1.2 an earlier internal project 的教训（本 PRD 的负面约束，红线级）

飞书常驻形态把 UX 押在七段外部依赖长链上（WS 网关→引擎→node→pi→代理→
沙箱→卡片回调），每段都是独立故障类；两次真实运行挖出 10+ 个 P1，最终以
d1 迁移门 boot 死循环（VPS 崩溃 14,900+ 次）和入站腿失联收场。结论：
**渠道层是税，治理前置是税，自建控制面全家桶是税**。新项目自持全部 UX
面，治理后置，架构上不允许任何"外部平台 schema 变更导致 UX 断"的依赖。

### 1.3 竞争格局

| 对手 | 底座 | 生态位 | 相对我们的弱点 |
|---|---|---|---|
| DS-Bot（ds-bot） | DeepSeek DSH 插件 | 已验证的品类标杆，4 周 5.5k★ | 治理全缺；绑 DSH 生态；无 pi 通道 |
| pi-bot（luodaoyi，弃坑） | pi SDK | 同路先发者 | 已死 3 周+；语义浅（群聊引擎 421 行 vs DS-Bot 状态机）；零治理 |
| Grok Bot / ProkBot | Cursor 闭源栈 | 大厂闭源版 + 私服补丁 | 闭源/法律高危/锁版本；非开源竞品 |

我们的位置：**pi 生态的 DS-Bot 级语义深度 + 全生态唯一的治理层 + 不弃坑**。

## 2. 目标与非目标

### 2.1 目标（按优先级）

| # | 目标 | 衡量 |
|---|---|---|
| G-1 | 单用户在本机跑起一个 Bot 团队并完成真实工作 | M2 后 Felix 连续两周每日真实使用 |
| G-2 | 新用户从安装到看见第一个 Bot 干完一件事 ≤ 30 分钟 | M3 验收实测（非 Felix 用户） |
| G-3 | 每条产品链路开发者可在本机 ≤ 30 秒重启验证 | 全链路无外部平台依赖 |
| G-4 | 预算成为卖点：每 Bot / 每群可设 token·费用上限，超限即停 | M2 交付即含，DS-Bot 用户最痛的点 |
| G-5 | 成为 pi 生态默认的多 Bot 编排层 | pi 包索引收录 + 外部贡献者出现 |

### 2.2 非目标（v1 红线）

- **不做 IM 渠道**（飞书/Telegram/微信）。渠道 adapter 最早 P2 评估，且永不
  为 UX 主路径。
- **不做多用户 / 多租户**（治理 G3 阶段之前）。单用户自托管是信任模型。
- **不做自建控制面全家桶**：无 metering proxy（用户 key 经 pi-ai 直连，预
  算在 host 层计量停机）、无事件溯源数据库（审计用 append-only JSONL）。
- **不 fork / 不 patch pi**（学 DS-Bot 铁律 "Build on DSH; never patch it"）：
  只用 pi 公开扩展面与 SDK；pi 不满足的能力做成 host 侧的层。
- **治理不前置**：预算之外的治理功能（审批分级、审计时间线）全部排在
  M3+，违者即为重蹈 an earlier internal project。
- 不做桌面打包（v1）、不做移动端、不做云托管版。

## 3. 用户与场景

### 3.1 用户画像

- **P0：Felix 本人**（个人开发者/PM）。日常研究、内容整理、代码杂务派给
  不同角色的 Bot；关心成本与"这活到底干了没有"。产品第一个真实用户与
  dogfood 闸门。
- **P1：pi 生态的个人开发者**（120k★ 底座的存量，英文界面）。同场景。
- **P2：小团队**（多 operator、共享预算与审计）——G3 治理落地后才存在。

### 3.2 核心用户故事（M2 验收基准）

1. 我创建一个 Chief + 两个职能 Bot（研究、写作），给每个 Bot 指定模型、
   effort 与月度预算。
2. 我在群聊里说一句话，Chief 应答并把活 @ 给写作 Bot；我能看到它干活的
   一句话进度；干完结果自动回群，Chief 接着回应我。
3. 我 @ 研究 Bot 直接对话，它记得我上周说过的偏好（bot 记忆 + 群记忆）。
4. 写作 Bot 本月预算耗尽时，它停机并在群里明确告诉我，而不是静默失败或
   继续烧钱。
5. 我在任何时候能查一条时间线：谁在什么时候花了多少、干了什么、谁批准的。

### 3.3 反场景（同样要验收）

- 群聊失控自我对话：连续无工具纯应答 N 次必须自动暂停等人（空闲乒乓守卫）。
- Bot A 派活给 B 后反过来等 B 的消息形成环：防环规则直接拒绝。
- 我关掉宿主机再开：所有 Bot 状态、记忆、台账无损恢复。

## 4. 产品形态

```
┌─────────────────────────────────────────────┐
│  薄 Web UI（自托管 localhost/LAN/Tailscale）  │
│  团队总览 · 群聊窗 · Bot 详情 · 用量预算 · 审计 │
├─────────────────────────────────────────────┤
│  codar-bot host（TS/Node daemon，产品本体）   │
│  群聊回合引擎 · handoff 工作树 · 记忆 ·        │
│  预算计量 · 审批 · append-only 审计 · CLI      │
├─────────────────────────────────────────────┤
│  pi 运行时（每 Bot 一个 session 进程）         │
│  agent loop · 工具 · 多 provider(pi-ai) ·     │
│  usage/cost · extensions（含可捐的 gate）      │
├─────────────────────────────────────────────┤
│  沙箱：Docker per Bot（默认开；host 模式须显式  │
│  降级并诚实标注 not-isolated）                 │
└─────────────────────────────────────────────┘
```

- **入口**：`codar` CLI（包名 `codar-bot`；start/stop/status + 终端对话兜
  底）+ Web UI；docker-compose 一键自托管（M3）。
- **模型**：用户自带 key，OpenAI 兼容 / Anthropic / Google（pi-ai 原生多
  provider）；per-Bot 固定模型 + effort，随时可换。
- **数据**：全部本地 `~/.codar-bot/`（state.json 花名册 + 会话数据 + 记忆
  + 审计 JSONL + usage SQLite 台账）。无云依赖、无遥测（默认）。
- **品牌边界**：README 显著声明与 pi（earendil-works）无隶属关系；中文文
  档只用英文品牌名（规避「科搭 Codar」音近混淆）；中文商标另行处置（§15）。

## 5. 核心概念（语义参考 DS-Bot，实现针对 pi）

| 概念 | 定义 | 参考实现 |
|---|---|---|
| Bot | 一个长驻 pi session：独立身份（名/角色/头像）、workDir、模型、effort、记忆、预算 | DS-Bot roster |
| Chief（Main Bot） | 特权 Bot：建/改/停 Bot 与群、指派模型、看全局用量；首次启动自动创建并引导配置 | DS-Bot Chief |
| 群（Room） | 成员 Bot 集合 + admin（默认应答人）+ 模式（admin 应答 / 全员轮次）+ 群记忆 + workDir | DS-Bot rooms |
| 回合引擎 | 真状态机：slots（waiting/speaking/posted/passed/working/failed…）、应答超时、工作不阻塞群聊、空闲乒乓守卫 | DS-Bot groups.js（其精华） |
| 派活（Handoff） | @Bot 或 Chief 调 message_bot；工作树（parent/child）+ request_id 幂等 + 防环（不许给等你结果的人发消息）+ 结果自动回流上溯 | DS-Bot handoffs.js |
| 进度 | 干活的 Bot 一句话状态实时进群；"谁在干活/第几分钟"注入群上下文 | DS-Bot statusOf |
| 记忆 | 三作用域：Bot 私有 / 群内共享 / 全队；固定尺寸分层（entry/main/topic）；每轮后小模型自动 review；快照冻结保证前缀缓存稳定 | DS-Bot memory.js |
| 预算 | 每 Bot / 每群：maxTokens + maxCostMicros + maxTurns + 墙钟；host 层计量（pi usage:cost，an earlier internal project 已验证），超限停机并群内广播 | an earlier internal project reserve/settle 语义简化版 |
| 审批 | 工具级：allow-once / allow-session / 规则（按工具×风险级）；默认写类操作询问 | an earlier internal project gate 语义简化版 |
| 审计 | append-only JSONL 时间线：谁·何时·调了什么工具·花了多少·谁批准 | an earlier internal project 因果时间线轻量版 |

## 6. 功能需求与里程碑

### M0 — Spike：pi 1.5.0 成色验证（约 1 周，硬闸门）

| 需求 | 验收 |
|---|---|
| S1 驱动面定案 | RPC 模式 vs pi-agent-core SDK 内嵌二选一（判定：会话生命周期控制、流式输出、中断、usage 回读谁更完整）；产出决定记录。已知旁证：pi-bot 选了 SDK（但其踩坑在 1.1.0 期） |
| S2 gate 可移植性 | an earlier internal project `an earlier internal gate`（tool-call 闸 + 审计钩）在 pi 1.5.0 上跑通"写文件须批准"用例 |
| S3 计量 | 每 session 回读 usage:cost 并按 Bot 聚合入库 |
| S4 沙箱 | Docker per Bot 起停 + workDir 挂载 + fail-closed（无容器 ⇒ 拒绝；显式 `--no-sandbox` 才降级且标注 not-isolated） |
| S5 生态位复核 | ✅ 已完成（2026-11-04）：luodaoyi/pi-bot 弃坑、实质空位，结论=继续（证据在 §1.1） |

**S1-S4 任一失败 ⇒ 暂停产品开发，先解决或改底座策略，不硬上。**

### M1 — 能聊（+2~3 周）

| 需求 | 验收 |
|---|---|
| 1.1 host 骨架 | roster/store（state.json + 文件锁 + 迁移）；`codar start` 起 host + Web UI |
| 1.2 单 Bot 对话 | Web UI 聊天窗 ↔ 一个 pi session，流式输出，中断按钮可用 |
| 1.3 Bot 管理 | Chief 建 Bot（名字/角色/workDir/模型/effort）；Bot 详情页 |
| 1.4 模型 | 至少 2 个 provider 实测可换（待 §15-4 定哪两个） |
| 1.5 用量记账 | 每 Bot × 模型 × 用途（chat/工具/记忆 review）台账 + 用量页 |

### M2 — 成团（+3~4 周，产品灵魂里程碑）

| 需求 | 验收 |
|---|---|
| 2.1 群聊回合引擎 | admin 默认应答；@路由（@all 仅 admin）；轮次状态机；应答超时；空闲乒乓守卫 |
| 2.2 派活 | @派活 + message_bot；工作树 + 防环 + request_id 幂等；进度进群；结果回群后 caller 被唤醒 |
| 2.3 记忆 | 三作用域 + 自动 review + 快照冻结；Bot 详情页可管理 |
| 2.4 群目标（stretch，可砍） | objective→stages→验收 最小版 |
| 2.5 预算（治理 G1） | 每 Bot/每群上限 + 超限停机 + 群内广播；预算页 |
| 2.6 Dogfood 闸门 | Felix 真实场景连续使用两周（G-1 达成后才进 M3） |

### M3 — 可治理、可分发（+3 周）

| 需求 | 验收 |
|---|---|
| 3.1 审批（治理 G2） | 工具级审批卡（Web UI 内），规则档（always/ask/never × 风险级），全键盘可操作 |
| 3.2 沙箱默认开 | Docker per Bot 默认启用；compose 一键自托管（host+UI+沙箱） |
| 3.3 审计线（治理 G3 简版） | append-only 时间线 + 审计页（按 Bot/群/时间过滤） |
| 3.4 分发 | `npm i -g codar-bot` + pi package 形态双通道 + 双语 README + 快速上手 |
| 3.5 新用户 30 分钟 | G-2 实测：一位非 Felix 用户走完安装→建团→干完一件事 |

### P2+（明确排序，不做承诺）

渠道 adapter（Telegram 先行评估）· 多 operator/团队 · 预算代理层（scoped
token）· 桌面打包 · 移动端 · 跨实例 federation（ProkBot 的 Ed25519 信封语
义可参考）· 群目标完整版

## 7. 非功能需求

| 维度 | 要求 |
|---|---|
| 性能 | host 冷启动 ≤ 3s；聊天首 token 转发延迟 ≤ 300ms（不含模型）；UI 群聊窗千条消息不卡 |
| 可靠性 | host 崩溃重启后 Bot/群/记忆/台账无损（幂等 store + 文件锁）；单个 Bot 进程崩溃不影响其他 Bot 与 host |
| 安全 | API key 只存本地（0600）；Web UI 默认绑 loopback，LAN/Tailscale 需显式开启+token；Docker 沙箱默认开（fail-closed）；无遥测（默认） |
| 成本透明 | 每次模型调用实时入台账；预算余量可随时查询（`codar budget show` / 群内 @chief） |
| 可移植 | macOS/Linux 优先（pi 1.5.0 支持面）；Node ≥ pi 要求版本；无超越 pi 自身的原生依赖 |
| 确定性测试 | 回合引擎/预算/防环必须有可离线复现的单测（mock LLM，学 DS-Bot mock-llm 模式） |

## 8. 界面与命令面

**Web UI 页面（M1 起逐步交付）**：① 团队总览（Bot 花名册/状态/在干啥）
② 群聊窗（消息流 + @ + 进度 + 审批卡内嵌）③ Bot 详情（模型/effort/记忆/
用量/预算）④ 用量与预算页 ⑤ 审计时间线（M3）⑥ 设置（provider/沙箱/备份）。

**CLI（bin `codar`）**：`codar start|stop|status`、`codar chat [bot]`（终
端兜底）、`codar bot ls|create|rm`、`codar group ls|new`、`codar budget
set|show`、`codar audit tail`。

**HTTP API（daemon 本地）**：REST + SSE（事件流给 UI 与集成）；v1 不承诺
稳定契约（README 标注 early development）。

## 9. 数据模型（核心对象概览）

```
~/.codar-bot/
  state.json      bots{id,name,role,model,effort,workDir,budget,…}
                  rooms{id,members,admin,mode,goal,workDir,log}
                  works{parent,child,requestId,status}     # handoff 工作树
  memory/         bots/<id>/ · groups/<id>/ · team/        # 三作用域 Markdown
  usage.sqlite    (hour × bot × model × kind) tokens/cost  # 台账
  audit.jsonl     append-only：tool-call · approval · budget-stop · lifecycle
```

## 10. 架构决策记录（ADR 摘要）

| # | 决策 | 理由 |
|---|---|---|
| A1 | pi 为唯一底座，never patch | MIT/120k★/官方留白编排层；an earlier internal project 已验证 RPC/gate/usage 面 |
| A2 | 自持 Web UI，不骑任何宿主 UI | 渠道/宿主是 an earlier internal project 最大税源；DS-Bot 骑 DSH Web 的便利用薄 UI 换回主导权 |
| A3 | host 单进程（TS/Node）+ 每 Bot 一 pi 子进程 | 隔离故障域；pi session 即 Bot 身份 |
| A4 | 预算在 host 计量停机，v1 无代理层 | 单用户信任模型；代理层是 an earlier internal project HEAVY 复杂度的主要来源 |
| A5 | 审计 = append-only JSONL，非事件溯源库 | 保留因果可查价值，砍掉投影/折叠/迁移复杂度（d1 事故直接教训） |
| A6 | an earlier internal project 资产按库捐赠（见 §14） | 已被 5383 测试钉过；捐语义优先于捐代码 |
| A7 | pi 版本 pin，升级走显式 bump + 回归闸 | an earlier internal project 七关学费；pi 1.3→1.5 已有 API 漂移先例 |
| A8 | 品牌 Codar Bot（两词书写）；域名只购 **codarbot.com** 一枚，且为可选步骤（DS-Bot 零域名先例，M3 前无硬需求）；防御域 codar-bot.com 起势后加购；文档不设独立域。**终审 2026-11-04，不再复议** | 域名=品牌书写的去空格映射：同构先例 7/7 融合（React Native→reactnative.dev、React Router→reactrouter.com、Node-RED→nodered.org 等，官网 title 实测）、bot 品类 4/4 融合（Dependabot/Renovatebot/ImgBot/Greenkeeper）；npm/GitHub 的杠是小写转写非品牌拼写；打字吸引子不对称（人只漏杠不加杠）；npm/GitHub/RDAP 已核零冲突。注：Auto-GPT=autogpt.net 论据实测失效（该域现为 AI 资讯站，官方为 agpt.co），不采信 |

## 11. 发布序列（顺序不可乱）

1. 域名（可选）：只买 codarbot.com 一枚（~$10/年，防抢注保险；DS-Bot 先例=零域名也能跑到 5.5k★，M3 前产品功能不需要域名；防御域 codar-bot.com 仅起势后加购）
2. `npm publish` 占名 codar-bot（占位 README）+ 建仓 `codarwang/codar-bot`（即公开，Apache-2.0，双语 README——§15-1 已决）
3. M0 spike（S1-S4 硬闸门）
4. M1 → M2（dogfood 闸门）→ M3（新用户 30 分钟闸门）
5. 正式开源发布与宣传（仓库自第 2 步起即公开；本步指发布公告/社区曝光）

## 12. 成功指标

- 北极星（M2 起）：**每周真实派活任务数**（Felix 自用量即第一指标）
- G-2：新用户 30 分钟上手（M3 实测记录）
- 生态：发布 3 个月内外部 issue/PR ≥ 10、pi 生态包索引收录
- 反指标（出现即报警）：单周 P1 ≥ 2；任何"外部平台 schema 变更导致 UX 断"
  的事件；预算计量误差 > 1%

## 13. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| pi 上游 API 漂移（1.3→1.5 已发生） | 高 | A7 pin+bump；M0 定驱动面；扩展面 > SDK 面优先（更稳） |
| pi 官方将来自己做编排（README 承诺不做，但承诺会变） | 中 | 做官方不会做的：治理 + 群聊 UX + 语义深度；保持可被吸收姿态（被吸收=赢） |
| 单人维护节奏（DS-Bot 单人 4 周 17 版是极限强度） | 中 | 范围纪律：M2 前无治理外功能；AI 辅助开发全流程 |
| 多 Bot 群聊成本失控 → 用户流失 | 高 | 预算即 M2 功能（非 M3）；默认群模式=admin 应答（省钱姿态） |
| 又犯 an earlier internal project 病（治理前置/渠道化/控制面膨胀） | 高 | §2.2 非目标为红线；每里程碑评审第一项=对照非目标自查 |
| 「科搭 Codar」中文市场混淆/商标摩擦 | 低-中 | 英文生态先发；中文只用英文名；CODAR 拉丁商标（9/42 类）人工核实后决定反向注册（§15-5） |
| 名字被抢注（域名/npm/商标） | 中 | §11-1 已修订：域名单枚可选、不锁 npm/开仓前置（DS-Bot 零域名到 5.5k★ 先例）；接受的风险：codarbot.com 延购窗口内或被第三方持有（README homepage 可改）；防御域后置=起势时 codar-bot.com 或已被占（v1.2） |

## 14. an earlier internal project 资产捐赠表

| 资产 | 形态 | 去向 |
|---|---|---|
| `extensions/an earlier internal gate`（tool-call 闸 + 审计钩） | 代码可捐 | M0-S2 移植到 pi 1.5.0 扩展面 |
| 预算 reserve/settle 语义（5383 测试钉过） | 语义捐（重写） | M2-2.5 预算引擎 |
| Docker 沙箱驱动（fail-closed + not-isolated 降级） | 语义捐 | M0-S4 / M3-3.2 |
| 因果审计时间线设计 | 语义捐（轻量化） | M3-3.3 append-only JSONL |
| 事件溯源/投影/折叠/metering proxy | **不捐**（an earlier internal project 病灶） | 留在封存仓 |

## 15. 开放问题（待 Felix 拍板）

1. **开源时机**：✅ 已决（2026-11-04）：直接 Apache-2.0 开源，建仓即公开，
   双语 README。
2. **M1 UI 栈**：✅ 已决（2026-11-04）：Vite+React 单页（SPA）。
3. **an earlier internal project 血缘**：✅ 已决（2026-11-04）：新仓从零 + 按 §14 捐，不 fork。
4. **M1 双 provider 必验哪两个**：⏳ 待定（M0 期内确认，不阻塞开工）：建议
   OpenAI 兼容 + Anthropic，以 Felix 手头 key 布局定。
5. **中文商标 + an earlier internal project 仓处置**：人工查 CODAR（拉丁）第 9/42 类（公开库
   有登录墙，需手机号登录商标网/标库网）；空 ⇒ 反向注册占先（first-to-file，
   个人可办 270 元/类）。an earlier internal project 仓最终处置（封存/删除）——删除前必须先
   推送本地未推的 `60508a5`。

---

## 附录：调研底稿索引

- DS-Bot 仓库级调研（2026-11-04）：架构/群聊状态机/handoffs/记忆/治理缺
  口，文件级证据——本会话档案
- ProkBot 仓库级调研（2026-11-04）：Cursor 闭源栈寄生补丁、与 pi 无关的
  字节级验证（CoreMessage/fullStream vs pi-ai 零命中）
- luodaoyi/pi-bot 验尸（2026-11-04）：36 commits/两天/弃坑/0★，克隆样本
  `/Users/felix/Tools/开源bot/_research/pi-bot`
- 命名排查（2026-11-04）：npm/GitHub/RDAP/中文品牌（科搭）全记录
- an earlier internal project 事故链（2026-11-04）：d1 boot-loop 根因与修复（本地提交 60508a5）

---

## 修订记录

- **2026-11-04 v1.1**：§15-1/2/3 由 Felix 拍板（直接 Apache-2.0 开源、
  Vite+React SPA、新仓从零+按 §14 捐）；§11 第 2/5 步措辞相应更新；§15-4
  限期 M0 期内确认；§15-5 维持待办（商标人工查、an earlier internal project 仓处置）。其余
  未改动。
- **2026-11-04 v1.2**：域名决策终审（Felix）：只购 codarbot.com 一枚，且
  为可选步骤（DS-Bot 零域名先例，M3 前无硬需求）——防御域 codar-bot.com
  起势后加购，文档域 codarbot.dev 取消（文档走仓库/主站）。§11-1/状态行/
  风险表相应更新；A8 重写并移除失效论据（Auto-GPT=autogpt.net 实测为 AI
  资讯站；有效证据=同构先例 7/7、bot 品类 4/4 融合，经 pi(devin/swe-2:max)
  两轮调研 + npm registry/官网 title 硬验证）。
