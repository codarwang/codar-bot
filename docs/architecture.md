# codar-bot 系统架构设计

| | |
|---|---|
| 版本 | v0.2（draft，待 Felix 评审） |
| 日期 | 2026-11-05 |
| 上游 | `docs/PRD.md` v1.2（需求权威；冲突时以 PRD 为准并走修订） |
| 证据基线 | pi 1.5.0（`@earendil-works/*` npm 包类型与源码逐字节读取，2026-11-04/05）+ WorkerOS `pi-adapter.ts` 实战注释（只读捐献） |
| 状态 | **评审闸门：本文档批准前不进 M0-S2/S3/S4 与 M1 编码** |

---

## 0. 文档定位

本文档是 codar-bot 的**架构权威**：进程模型、模块边界、接口契约、数据
schema、关键时序、故障域。PRD 回答「做什么/为什么」，本文档回答「怎么组
织」。M0 各 spike 是对本文档假设的**验证**（§9 判据映射），M1 起的实现以
本文档为准；实现中发现偏差 → 回改本文档并记修订，不允许代码静默漂移。

## 1. 系统上下文与进程模型

```
                    ┌────────────────────────────────────────────┐
                    │  codar host daemon（单进程，TS/Node ≥20）    │
                    │                                            │
 Web UI (SPA) ◄─────┤  HTTP API (REST + SSE)   CLI (codar)       │
 浏览器/Tailscale    │  ┌──────────────────────────────────────┐  │
                    │  │ turn-engine · handoff · memory ·      │  │
                    │  │ budget · approval · audit · store     │  │
                    │  └──────────┬───────────────────────────┘  │
                    │             │ driver（RPC 客户端 × N）      │
                    └─────────────┼──────────────────────────────┘
                                  │ stdin/stdout JSONL（RPC 协议）
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
      ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
      │ Bot A 进程    │    │ Bot B 进程    │    │ Chief 进程    │
      │ pi --mode rpc │    │ pi --mode rpc │    │ pi --mode rpc │
      │ (Docker 容器) │    │ (Docker 容器) │    │ (Docker 容器) │
      │ + extension  │    │ + extension  │    │ + extension  │
      └──────────────┘    └──────────────┘    └──────────────┘
            ~/.codar-bot/（全部状态：state.json · sessions/ · memory/ ·
                          usage.sqlite · audit.jsonl · logs/）
```

进程模型决定（= PRD A3 细化）：

| 决策 | 内容 | 理由 |
|---|---|---|
| P-1 | host 单进程（daemon），常驻 | 单用户自托管；store 在进程内单写者，文件锁只防外部并发 |
| P-2 | **每 Bot 一个 pi 子进程**，长驻 RPC 会话 | 故障域隔离（Bot 崩溃不影响 host/其他 Bot）；pi session 进程即 Bot 身份 |
| P-3 | 子进程默认跑在 Docker 容器内（M0-S4 验证） | fail-closed 沙箱；host 模式须显式 `--no-sandbox` 且全 UI 标注 not-isolated |
| P-4 | Web UI 是 host 服务的静态 SPA（Vite+React），仅经 REST+SSE 通信 | 自持 UX 面（A2）；无任何外部平台依赖（反 WorkerOS 红线） |
| P-5 | CLI `codar` 与 UI 走同一 HTTP API | 单一契约；终端兜底对话 = 同一 driver |

## 2. 驱动层（Driver）——S1 定案

### 2.1 决策：**RPC 模式**（`pi --mode rpc` 子进程），否决 SDK 内嵌

| 维度 | RPC（选定） | SDK（`@earendil-works/pi-agent-core`） |
|---|---|---|
| 故障域 | 每 Bot 独立进程，符合 P-2 ✅ | N 个 Agent 实例共居 host 进程，Bot 崩溃 = host 崩溃 ❌ |
| 版本耦合 | JSONL 协议解耦，pi 升级不重编 host（A7 友好）✅ | 编译期 API 耦合，1.3→1.5 漂移先例直接打爆编译 ❌ |
| 扩展面 | `--extension` 加载（workeros 已验证）；gate/审批/UI 桥全在协议内 ✅ | extension/session/compact 等面在 pi-coding-agent 层，agent-core 不含，需自行重建 ❌ |
| S1 四项验收 | 生命周期 `new_session/switch_session/fork/clone`；流式=事件流；中断 `abort/abort_bash`；usage=`get_session_stats`+`message_end.usage` 全齐 ✅ | Agent 类同样四项齐 ✅（但被前三项压倒） |
| 实战先例 | WorkerOS 全链验证（驱动/审批桥/计量）；官方 `rpc-client.js` 参考实现可循 ✅ | pi-bot 选了 SDK（1.1.0 期踩坑史）⚠️ |

### 2.2 协议事实（pi 1.5.0 `rpc-types.d.ts`，逐字节证据）

- **命令面**（stdin，JSONL，`{type, id?, ...}`）：`prompt`（streamingBehavior:
  steer|followUp）、`steer`、`follow_up`、`abort`、`clear_queue`、
  `new_session`（parentSession?）、`switch_session`（sessionPath）、`fork`
  （entryId）、`clone`、`set_model`（provider+modelId）、`set_thinking_level`、
  `compact`、`get_session_stats`、`get_messages`、`get_tree`、`bash`、
  `abort_bash`、`set_session_name`、`get_commands` 等 28 种。
- **响应**：`{type:"response", command, success, data|error, id?}`，`id` 关联。
- **事件流**：AgentSessionEvent 持续外发（`message_update` 带 text_delta 流式；
  `message_end` 的 assistant message 含 `usage`——pi-ai `Usage` 形状：
  input/output/cacheRead/cacheWrite(+1h)/thinking + **cost at catalog price**）。
- **usage 汇总**：`get_session_stats` → `SessionStats{tokens{input,output,
  cacheRead,cacheWrite,total}, cost, contextUsage, …}`。
- **审批/UI 桥**：`extension_ui_request{id, method: confirm|select|input|…}` →
  客户端回 `extension_ui_response{id, confirmed|value|cancelled}`。gate 审批
  即走此桥（workeros 在 1.3.0 已验证同构机制）。

### 2.3 驱动器职责与工程红线

1. **分帧**：stdout 按 **byte-split-on-LF** 解析，禁用 `readline`（它在
   U+2028/U+2029 上也会分行，而两者是 JSON 字符串合法字符——WorkerOS 学费）。
2. **有界一切**（继承 WorkerOS supervisor 模式）：prompt 字节、单行字节、
   事件流总量、空闲超时、墙钟超时；关闭 = SIGTERM → grace → SIGKILL。
3. **错误映射**：`agent_settled{aborted}`、`message_end{stopReason:"error"}`
   （如 provider 402 budget_exhausted）必须显式上抛为 Bot 失败事件，禁止静默
   成功（WorkerOS 实测：pi 把 provider 拒绝表现为 error assistant message 后
   正常 settle）。
4. **会话恢复**：Bot 重启后以 `switch_session(sessionPath)` 接续（session 文件
   由 pi session-manager 落盘在 `~/.codar-bot/sessions/<botId>/`）。

### 2.4 Bot 进程生命周期状态机

```
            spawn                      ready
  stopped ─────────► starting ─────────────► idle ◄─────────────────┐
     ▲                  │ RPC ready           │ prompt()            │
     │ stop()           │ fail                ▼                     │
     │ budget-stop      ▼                  working ──── settle ─────┘
     └──────────── crashed ◄─── crash/timeout/error
```

- `crashed` → 自动重启（指数退避，上限 3 次未恢复则停机并告警），恢复走
  `switch_session`；
- `budget-stop` 不自动重启，等用户或次周期；
- 所有状态迁移写 `audit.jsonl`（lifecycle 事件）。

## 3. host 内部模块

模块间只经显式接口通信；`store` 是唯一持久化写者；`audit` 是唯一 append-only
写者。箭头 = 编译期依赖方向（禁止环）。

```
api ──► turn-engine ──► handoff ──► driver
 │           │             │          ▲
 │           ▼             │          │
 │        memory ◄──────────┤       budget（读 driver 的 usage 事件）
 │           │             │          │
 ├──────► store ◄───────────┴────► approval ──► driver（ui_response 回写）
 │                                     │
 └───────────────────────────────► audit
```

| 模块 | 职责 | 关键接口（v1 契约） |
|---|---|---|
| `driver` | 每 Bot 一个 RPC 客户端：spawn/分帧/命令/事件流/中断/恢复 | `start(bot)`, `stop(botId)`, `prompt(botId, text, opts)`, `abort(botId)`, `events: AsyncEmitter<DriverEvent>`, `stats(botId)` |
| `store` | state.json 读写 + 文件锁 + schema 迁移 + 原子写（tmp+rename） | `load()`, `save(mutator)`, `migrate()` |
| `turn-engine` | 群聊回合状态机（§6.1） | `ingest(roomId, msg)`, `slots(roomId)`, 事件 |
| `handoff` | 派活工作树：parent/child、request_id 幂等、防环、结果回流（机制见 §3.1） | `dispatch(roomId, fromBot, toBot, task)`, `onResult(work)`, `works(roomId?)` |
| `memory` | 三作用域（bot/room/team）Markdown + 分层 + 快照冻结 + review 触发 | `snapshot(scope, id)`, `ingestTurn(...)`, `review(scope, id)` |
| `budget` | usage 聚合入库、限额检查、超限停机 | `record(usage)`, `check(botId|roomId)`, `setLimit(...)`, 超限→`driver.stop` + 群广播 + audit |
| `approval` | 审批卡状态机 + 规则档（always/ask/never × 风险级） | `onGateRequest(req)`, `resolve(id, decision)`, 规则求值 |
| `audit` | append-only JSONL（唯一写入者，fsync） | `append(event)` |
| `api` | REST + SSE；SSE 事件：message/progress/approval/budget/system | 路由表见 §7 |
| `ui` | Vite+React SPA（M1 交付） | — |

### 3.1 message_bot 派活机制（D1 决议 2026-11-05：复用 extension_ui 桥）

pi 的工具在子进程内执行，而派活必须被 host 感知。机制：

1. host 给每个 Bot 的 pi 子进程注入一个 `codar` extension，注册
   `message_bot(to, task)` 工具（结构化参数：目标 Bot、任务描述）。
2. Bot 模型调用 `message_bot` 时，extension **不本地执行**，而是经
   `extension_ui_request` 桥抛出（与 gate 审批同通道，workeros 已验证），
   子进程 park 该工具调用等待响应。
3. host driver 收到请求 → `handoff.dispatch`（建工作树、防环检查、request_id
   幂等）→ 调度目标 Bot → 回 `extension_ui_response`（受理确认；工具结果为
   「已受理，工作 id=work_xxx」）→ 调用方 Bot 的回合可正常结束。
4. 目标 Bot settle 后，`handoff.onResult` 将结果作为**新 prompt** 喂回 caller
   （若 caller 空闲直接唤醒；若在忙则进 follow-up 队列）——PRD 3.2-2 的
   「Chief 接着回应我」由此实现。

注：`@Bot` 文本路由仍由 turn-engine 解析（PRD §5 两条路并存：@ 派活 +
message_bot 工具派活）；ui 桥是工具路专用的结构化通道。

## 4. 数据模型（schema v1）

```
~/.codar-bot/
  state.json                  # store 原子写，0600
  sessions/<botId>/…          # pi session 文件（pi 自管，host 只存路径引用）
  memory/
    bots/<botId>/{entry.md,main.md,topics/*.md}
    rooms/<roomId>/{entry.md,main.md,topics/*.md}
    team/{entry.md,main.md,topics/*.md}
  usage.sqlite
  audit.jsonl
  logs/host.log
```

**state.json**（示意）：

```jsonc
{
  "schemaVersion": 1,
  "bots": [{
    "id": "bot_xxx", "name": "Writer", "role": "…", "avatar": "…",
    "model": {"provider": "anthropic", "modelId": "…", "thinkingLevel": "high"},
    "workDir": "/abs/path",          // Bot 私有卷（容器内 ~/work，可写）
    "sessionPath": "sessions/bot_xxx/…",
    "sandbox": {"mode": "docker" | "host-not-isolated"},
    "budget": {"maxTokens": 5e6, "maxCostMicros": 20000000, "maxTurns": 2000, "maxWallMs": 3600000},
    "status": "idle"            // 运行态快照，重启后由 driver 重建
  }],
  "rooms": [{
    "id": "room_xxx", "name": "…", "members": ["bot_a", "bot_b"],
    "admin": "bot_chief", "mode": "admin-reply" | "round-robin",
    "sharedDir": "/abs/path"        // Room 共享卷（成员容器内 ~/shared，可写；
                                    //  D2 决议 2026-11-05：双卷拓扑。并发写冲突
                                    //  M2 靠约定（文件名带 Bot 前缀），检测排 P2）
  }],
  "works": [{
    "id": "work_xxx", "parent": "bot_a", "child": "bot_b",
    "requestId": "req_xxx",    // 幂等键
    "status": "pending" | "working" | "done" | "failed" | "rejected",
    "roomId": "room_xxx"
  }],
  "reviewModel": {              // D3 决议 2026-11-05：全局 review 专用模型槽位，
    "provider": "…", "modelId": "…", "thinkingLevel": "…"
  }                             // 定位为可比干活模型更强的模型（质量优先）；
}                               // 默认策略（含未配置时的回落行为）M2 细聊定
```

**usage.sqlite**（台账，S3 验证对象）：

```sql
CREATE TABLE usage (
  hour TEXT NOT NULL,          -- UTC 'YYYY-MM-DDTHH'
  bot_id TEXT NOT NULL,
  model TEXT NOT NULL,         -- 'provider/modelId'
  kind TEXT NOT NULL,          -- 'chat' | 'tool' | 'memory-review'
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, bot_id, model, kind)
);
```

**audit.jsonl**（事件 union；每行 `{ts, kind, …}`）：
`tool-call` / `approval`{decision, by} / `budget-stop`{limit, spent} /
`lifecycle`{botId, from, to, reason} / `handoff`{workId, event}。

## 5. 关键时序

### 5.1 群聊一回合（PRD 3.2-2）

```
用户(admin) ── msg ──► api ──► turn-engine.ingest
  turn-engine: slots 更新 → 选应答者（默认 admin 模式=Chief；@Bot 直达）
  → driver.prompt(botId, 群上下文渲染, {streamingBehavior:"steer"})
  → message_update(text_delta) 逐条 → SSE → UI 流式
  → message_end(usage) ──► budget.record ──► usage.sqlite
  → agent_settled → turn-engine 回合收尾 → 消息入群 log
```

### 5.1a 群聊上下文渲染格式（v0.2 草案，M2 实现期可调）

每次向某 Bot 的 pi 进程发 prompt 时，群历史按以下格式渲染（系统段 +
对话段，保证各 Bot 看到一致的因果链）：

```
[系统段]
You are {bot.name} in team room "{room.name}". Members: {names}.
Currently working: {bot who is working + one-line progress, or "nobody"}.
Shared files live in ~/shared (prefix your writes with your name).

[对话段]（按时间序，非本 Bot 的发言以观察者视角呈现）
[user @ admin] 用户消息原文
[{bot.name}] 该 Bot 自己的历史发言（只保留最近 K 条 + 摘要）
[{other_bot.name}] 其他 Bot 发言原文
[system] 工作事件（派活受理/完成/预算停机等一句话广播）
```

- 本 Bot 自己的历史走 pi session 上下文（session 内天然有），对话段只渲染
  **其他成员**的消息——避免重复注入；
- 「谁在干活 + 进度」注入即 PRD §5 statusOf 语义；
- K 与摘要策略由 memory 模块决定（快照冻结保证前缀缓存稳定）。



```
Chief 应答中调 message_bot(to=Writer, task)
  → handoff.dispatch: 建 works 节点(requestId) → 防环检查（§6.2）
  → driver.prompt(Writer) 并行执行；群聊不阻塞（turn-engine 释放回合）
  → Writer tool_execution_update → 进度一句话进群（SSE progress）
  → agent_settled → handoff.onResult → 结果消息回群
  → 若 parent 在等待：driver.prompt(parent, 结果+唤醒上下文)
```

### 5.3 预算停机（PRD 3.2-4，反静默失败）

```
budget.record 后 check(botId) 超限
  → driver.abort(botId) → driver.stop(botId)（不自动重启）
  → audit.append(budget-stop) → api 广播 SSE(budget) → 群内系统消息
     「Writer 本月预算已耗尽，已停机」
```

### 5.4 审批（M0-S2 验证机制，M3 产品化）

```
Bot 工具调用命中 gate → 子进程发 extension_ui_request{confirm}
  → driver 归一化 → approval.onGateRequest → 规则求值
     ├─ always → 自动 confirmed:true（audit 记录）
     ├─ never  → 自动 confirmed:false（工具被拒）
     └─ ask    → SSE(approval) → UI 审批卡 → api.resolve
  → driver 回写 extension_ui_response{id, confirmed} → pi 续跑
```

### 5.5 host 崩溃恢复（PRD 3.3-3）

```
codar start → store.load（schema 迁移）→ 逐 Bot spawn + switch_session
  → works 中 pending/working 标记 failed（reason:"host-restart"，不猜状态）
  → audit.append(lifecycle) 全量记录
```

## 6. 核心算法边界

### 6.1 turn-engine（语义参考 DS-Bot groups.js，M2 实现 + 单测）

- slot 状态：`waiting / speaking / posted / passed / working / failed / timed-out`
- 触发规则：admin 模式默认 Chief 应答；`@Bot` 直达；`@all` 仅 admin 可发；
- 守卫（D4 决议 2026-11-05，出厂默认，全部 per-room 可配置）：应答超时
  =180s 无首 token；**空闲乒乓守卫** =连续 4 次无工具调用的纯应答即自动
  暂停等人（PRD 3.3-1）；
- 确定性：引擎纯函数化（输入=消息流+花名册快照，输出=调度决策），单测用
  mock LLM 回放（学 DS-Bot mock-llm）。

### 6.2 handoff 防环（M2 实现 + 单测）

规则：**不允许给「正在等你结果」的 Bot 发消息**。实现=工作树 DFS 检查
`pending parent 链`；命中 → `works.status=rejected` + 群内提示。request_id
幂等：同 requestId 重复 dispatch → 返回既有 work，不重复执行。

## 7. HTTP API 面（v1 不承诺稳定）

```
GET  /api/overview                 GET  /api/bots[/:id]      POST /api/bots
GET  /api/rooms[/:id]/messages     POST /api/rooms/:id/messages
GET  /api/usage?bot=&room=&since=  GET  /api/budget/:scope
POST /api/approvals/:id/resolve    GET  /api/audit?filter…
GET  /api/events                   # SSE：message|progress|approval|budget|system
```

## 8. 故障域与安全

| 面 | 策略 |
|---|---|
| Bot 进程崩溃 | 隔离 + 退避重启（≤3）+ switch_session 恢复 + audit |
| host 崩溃 | state.json 原子写 + usage 幂等 upsert + 不猜 works 状态 |
| provider 故障 | stopReason:"error" 显式上抛（§2.3-3）；自动重试交 pi `set_auto_retry` |
| API key | 0600 本地；UI 默认 loopback；LAN/Tailscale 显式开 + token |
| 沙箱 | 默认 Docker per Bot（S4）；fail-closed；`--no-sandbox` 全链路标注 not-isolated |
| 红线自查 | 无 IM 渠道、无多租户、无代理层、无事件溯源库（审计=JSONL）；每里程碑评审第一项 |

## 9. M0 验证判据映射（本文档假设 → spike）

| 假设条款 | spike | 通过判据 |
|---|---|---|
| §2.2 协议事实在真实进程成立（命令/事件/ui 桥） | S1 ✅ | 已完成：类型逐字节读取 + 本机 pi 1.5.0 实测环境就绪 |
| §5.4 审批桥：workeros-gate 在 1.5.0 扩展面可跑 | **S2** | 容器外裸进程：写文件 → confirm 请求到达 host mock → 拒绝则文件未写、同意则写入；audit 行落盘 |
| §4 usage.sqlite + §2.2 usage 回读 | **S3** | 单 session 跑 ≥2 轮，message_end.usage 与 get_session_stats 交叉一致（误差 0），入库可查 |
| §1 P-3 容器化驱动 | **S4** | docker run 起 pi RPC 容器 + workDir 挂载 + stdin/stdout 通透 + 无 Docker 时启动被拒（fail-closed） |

任一失败 ⇒ 暂停产品开发（PRD §6 硬闸门），回改本文档对应章节。

## 修订记录

- 2026-11-05 v0.1：初稿（S1 结论落文 §2；M0-S2/S3/S4 判据固化 §9）。
- 2026-11-05 v0.2：gstack-spec 审讯四决议落文——D1 `message_bot` 走
  extension_ui 桥（新增 §3.1）；D2 workDir 双卷拓扑（Bot 私有 + Room 共享，
  §4）；D3 全局 review 专用模型槽位（§4，定位为更强的模型，默认策略 M2
  细聊）；D4 乒乓守卫 N=4 / 应答超时 180s（§6.1）。补缺口：budget
  `maxWallMs`（PRD §5 墙钟维度此前漏）；补群聊上下文渲染格式草案（§5.1a）。
