# codar-bot 系统架构设计

| | |
|---|---|
| 版本 | v0.5（循环审计已收敛，待 Felix 终审） |
| 日期 | 2026-11-05 |
| 上游 | `docs/PRD.md` v1.4（需求权威；冲突时以 PRD 为准并走修订） |
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

### 2.3a RPC spawn 契约

- **二进制来源**：`@earendil-works/pi-coding-agent`（bin `pi`），版本 pin
  1.5.0 于 host 的 package.json；用户侧两种安装形态（本机受管安装
  `~/.pi/agent/` 或 host 内置依赖），`codar doctor` 负责探测。
- **argv 模板**（cwd = 容器内 workDir 挂载点）：
  `pi --mode rpc --extension <codar-ext 路径> [--session <sessionPath>] [--model provider/modelId] [--thinking <level>]`
- **ready 判定**：spawn 后发 `get_state`，收到首个 `success:true` response
  即 starting→idle（具体事件序 S2 实测后固化，此处为契约目标）。`get_state`
  与 `set_auto_retry`（§8 重试依赖）未在 §2.2 清单逐条点名，一并纳入
  S2-④/S3 实测确认范围。

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

模块间只经显式接口通信；**`store` 是 state.json 的唯一写者**；append-only
面各有唯一写者：`audit.jsonl` ← audit 模块，`rooms/<id>/messages.jsonl` ←
turn-engine。箭头 = 编译期依赖方向（禁止环）。

```
api ──► turn-engine ──► handoff ──► driver
 │           │    │          │          ▲
 │           ▼    └──(prompt)─┼─────────┤（turn-engine 直接 prompt 应答者）
 │        memory ◄───────────┤       budget（读 driver 的 usage 事件）
 │           │               │          │
 ├──────► store ◄─────────────┴────► approval ──► driver（ui_response 回写）
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

### 3.2 Chief 管理通道（P1 修复 2026-11-05）

Chief 的特权操作（PRD §5：建/改/停 Bot 与群、指派模型、看全局用量）走与
§3.1 **同一机制**：codar extension 注册管理工具集，调用经 ui 桥抛 host 执行：

- 工具集（v1）：`create_bot(name, role, model, effort, budget)` /
  `update_bot(id, …)` / `stop_bot(id)` / `create_room(name, members, mode)` /
  `update_room(id, …)` / `pause_room(id)` / `delete_room(id)` /
  `set_bot_model(id, provider, modelId)` / `view_usage(scope)`。
- **单聊语义**（M1 首日决策，P3 收官拍板）：单聊 = 单成员 room（成员=该
  Bot，admin=该 Bot 与用户），复用同一回合引擎与 messages.jsonl，无独立
  代码路径。
- 审批：写类管理操作（stop/create/update）默认过 approval `ask` 档（M3
  产品化前由 host 日志 + SSE 卡呈现，CLI 确认）；`view_usage` 只读直通。
- **首启 bootstrap 时序**：`codar start` 检测 state.json 不存在 → 进入引导
  （CLI/Web 表单）：录 provider key（→ `~/.codar-bot/keys.json`，0600）→ 选
  Chief 模型 → host 创建 Chief bot + 默认 room（admin=Chief）→ 首次 spawn。
  首启不依赖任何 Bot 工具调用（避免鸡生蛋）。

### 3.3 Provider key 存储与注入（P1 修复 2026-11-05）

- 存储：`~/.codar-bot/keys.json`（0600，**独立于 state.json**——state 可被
  用户随意查看/备份，key 隔离），结构：
  `{providers: {<name>: {apiKey, baseUrl?, models?}}}`——`baseUrl`/`models`
  支撑 OpenAI 兼容自定义端点（写入 pi 的 provider 配置，见下）。
- 注入：**标准 provider**（anthropic/openai/google 等 pi 内置）以环境变量
  注入（`ANTHROPIC_API_KEY` 等 pi 认可的 env 名，容器模式经 `docker run -e`，
  不落盘镜像）；**自定义 provider**（自定义 baseUrl）经 pi 公开配置面供给：
  容器设 `PI_CODING_AGENT_DIR=/state/pi-conf`（重定向 agent 目录），host 从
  keys.json 在该目录生成 `models.json`（providers 段含 baseUrl/models）；
  片段内 apiKey 用 `$ENV` 插值引用、不双份落盘（key 唯一实存于 keys.json）。
  注意该 env 重定向的是整个 agent 目录（settings/auth/extensions 解析位
  置随之变化），容器内的叠加影响 S3 实测确认。
  key 永不出现在 argv（进程列表可见）、永不入 state.json、永不回显完整值。
- 录入面：§7 `GET/PUT /api/settings/providers`（GET 脱敏回显 `sk-…abcd`）。

### 3.4 容器挂载表（P1 修复 2026-11-05）

| 宿主路径 | 容器内路径 | 说明 |
|---|---|---|
| `~/.codar-bot/sessions/<botId>/` | `/state/sessions` | pi session 落**宿主侧**，容器重启不丢（P1-3 修复） |
| `<bot.workDir>` | `/home/bot/work` | Bot 私有卷，可写 |
| `<room.sharedDir>` | `/home/bot/shared` | Room 共享卷，可写（多 Bot 同挂） |
| `~/.codar-bot/extensions/codar-ext/` | `/opt/codar-ext` | codar extension（只读挂载） |
| `~/.codar-bot/pi-conf/<botId>/` | `/state/pi-conf` | host 生成的 pi provider/models 配置片段（自定义端点用，只读） |

key 走 env，不挂载。**路径规则**：store 里一律存宿主绝对路径；driver 在
spawn / `switch_session` 时按本表换算为容器内路径。S4 判据含「session 文件
持久化在宿主侧」验证项。

## 4. 数据模型（schema v1）

```
~/.codar-bot/
  state.json                  # store 原子写，0600
  keys.json                   # 0600，§3.3（独立于 state.json）
  sessions/<botId>/…          # pi session 文件（pi 自管，host 只存路径引用）
  rooms/<roomId>/messages.jsonl   # 群消息 append-only 流（turn-engine 写）
  memory/
    bots/<botId>/{entry.md,main.md,topics/*.md}
    rooms/<roomId>/{entry.md,main.md,topics/*.md}
    team/{entry.md,main.md,topics/*.md}
  pi-conf/<botId>/…           # host 生成的 pi provider 配置片段（自定义端点）
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
    "sessionPath": "/Users/you/.codar-bot/sessions/bot_xxx/…",   // 宿主绝对路径
                                                                  // （§3.4 路径规则）
    "sandbox": {"mode": "docker" | "host-not-isolated"},
    "budget": {"maxTokens": 5e6, "maxCostMicros": 20000000, "maxTurns": 2000, "maxWallMs": 3600000},
    "status": "idle"            // 运行态快照，重启后由 driver 重建
  }],
  "rooms": [{
    "id": "room_xxx", "name": "…", "members": ["bot_a", "bot_b"],
    "admin": "bot_chief", "mode": "admin-reply" | "round-robin",
                                    // paused 不入 mode 枚举：群暂停是运行态
                                    // （rooms.status: active|paused，重启保持，
                                    //  次月窗口重置或用户手动恢复），见 §5.3
    "sharedDir": "/abs/path",       // Room 共享卷（成员容器内 ~/shared，可写；
                                    //  D2 决议 2026-11-05：双卷拓扑。并发写冲突
                                    //  M2 靠约定（文件名带 Bot 前缀），检测排 P2）
    "budget": {…},                  // 同 bots.budget 结构（群级限额，P2 修复）
    "goal": null,                   // M2-2.4 stretch，缓建（P3 标注）
    "guards": {"pingPongN": 4, "replyTimeoutMs": 180000}   // D4 出厂默认，可改
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
  cache_write_1h INTEGER NOT NULL DEFAULT 0,   -- pi Usage 档位拆分（P2 修复）
  cost_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, bot_id, model, kind)
);
```

- **kind 判定规则**（P2 修复）：用户/admin 消息触发的回合 = `chat`；handoff
  派活触发的回合 = `tool`；memory review 调用 = `memory-review`（M2 起）。
  M1 只有前两类。
- **cost_micros 换算**：`round(cost_usd × 1e6)`；pi `Usage.cost` 的实际单位
  S3 实测确认，如有出入回改本节并记修订。
- **对账闭环**（P2 修复）：每 `agent_settled` 后 driver 缓冲的 usage 事件与
  `get_session_stats` 交叉核对，偏差 > 1% 写 audit 告警事件（闭环 PRD §12
  反指标）；host 崩溃恢复时以 `get_session_stats` 补账——补账前提：**每
  session 持久化「已入账水位」**（最近一次入账的 settled 序号/累计值，随
  state.json 存），补账 = 当前累计 − 水位，按 hour/kind 差量重建。
- **memory-review 执行载体**（P3，方向性约定）：review 由 host 驱动一个
  专用**短命 pi 子进程**（reviewModel 配置）执行，usage 入台账
  `bot_id = 被记的 scope id`（bot_xxx / room_xxx / team——与 state.json id
  同风格，P3 对齐），kind=memory-review；细节 M2-2.3 定。

**rooms/<roomId>/messages.jsonl**：群消息 append-only 流（P3 修复）——SSE
断线重连/历史回放的数据源；与 audit.jsonl 分离（治理事件 vs 对话内容）。

**audit.jsonl**（事件 union；每行 `{ts, kind, …}`）：
`tool-call` / `approval`{decision, by} / `budget-stop`{limit, spent} /
`lifecycle`{botId, from, to, reason} / `handoff`{workId, event}。

## 5. 关键时序

### 5.1 群聊一回合（PRD 3.2-2）

```
用户(admin) ── msg ──► api ──► turn-engine.ingest
  turn-engine: slots 更新 → 选应答者（默认 admin 模式=Chief）
  → @Bot 文本派活 = 同样调 handoff.dispatch（requestId 从消息 id 派生，
    过防环+幂等，P2 修复）→ handoff 决定即时应答或建工作树
  → driver.prompt(botId, 群上下文渲染, {streamingBehavior:"steer"})
  → message_update(text_delta) 逐条 → SSE → UI 流式
  → message_end(usage) ──► budget.record ──► usage.sqlite
  → agent_settled → turn-engine 回合收尾 → 消息 append 入 messages.jsonl
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
[{other_bot.name}] 其他 Bot 发言原文
[system] 工作事件（派活受理/完成/预算停机等一句话广播）
```

- 本 Bot 自己的历史走 pi session 上下文（session 内天然有），对话段只渲染
  **其他成员**的消息——避免重复注入；且为**增量注入**：每回合只注入上次
  注入之后的新消息（历史由 pi session 上下文承载，防止上下文二次膨胀）；
- 记忆快照（三作用域）注入于系统段尾部，随 memory 快照冻结而稳定（M2 细化）；
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

**群级超限**（P3 补）：`check(roomId)` 超限 → 群内所有 working 成员
`driver.abort` + 该群暂停收活（群 mode 置 paused，Bot 不销毁、私聊不受
影响）→ 群广播 + audit；用户调整限额或次月自动恢复。

### 5.4 审批（M0-S2 验证机制，M3 产品化）

```
Bot 工具调用命中 gate → 子进程发 extension_ui_request{confirm}
  → driver 归一化 → approval.onGateRequest → 规则求值
     ├─ always → 自动 confirmed:true（audit 记录）
     ├─ never  → 自动 confirmed:false（工具被拒）
     └─ ask    → SSE(approval) → 审批面 → api.resolve
  → driver 回写 extension_ui_response{id, confirmed} → pi 续跑
```

**M1/M2 默认档**（P2 修复，防 M1 单 Bot 对话挂死）：读类工具 `always`、
写类 `ask`——`ask` 的确认兜底**适用于全部 gate 请求**（不限于管理工具）：
Web UI 以 SSE 审批事件 + 简版卡呈现，`codar chat` 终端以交互确认；M3 才
做完整审批产品化（规则档/键盘流）。

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

### 6.1a 预算窗口语义（P3 修复，M2-2.5 前可再调）

- `maxTokens/maxCostMicros/maxTurns` 按**自然月**窗口累计（UTC 月初重置）；
- `maxTurns` 计数 = `agent_settled` 事件次数；
- `maxWallMs` = **单任务墙钟**（一次派活/一个回合的墙钟上限），非周期累计。

### 6.2 handoff 防环（M2 实现 + 单测）

规则：**不允许给「正在等你结果」的 Bot 发消息**。实现=工作树 DFS 检查
`pending parent 链`；命中 → `works.status=rejected` + 群内提示。request_id
幂等：同 requestId 重复 dispatch → 返回既有 work，不重复执行。

## 7. HTTP API 面（v1 不承诺稳定）

```
GET  /api/overview                 GET  /api/bots[/:id]
POST /api/bots                     PATCH /api/bots/:id
POST /api/bots/:id/stop            DELETE /api/bots/:id      # 停机与删除分离（P2 修复）
POST /api/rooms                    GET  /api/rooms[/:id]
PATCH /api/rooms/:id               DELETE /api/rooms/:id
GET  /api/rooms[/:id]/messages?since=   POST /api/rooms/:id/messages
GET  /api/usage?bot=&room=&since=  GET  /api/budget/:scope   PUT /api/budget/:scope
POST /api/approvals/:id/resolve    GET  /api/audit?filter…
GET  /api/settings/providers       PUT  /api/settings/providers   # GET 脱敏回显
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
| §5.4 审批桥 + §3.1 结构化桥（D1 核心） | **S2** | ① 容器外裸进程：workeros-gate 移植后，写文件 → confirm 请求到达 host mock → 拒绝则文件未写、同意则写入；audit 行落盘。② **自定义 ui_request 结构化往返**：extension 发自定义 method 请求（含参数），host 回结构化 value，子进程正确收到——D1 机制的前提。③ 长时 park：请求挂起 ≥60s 无响应，子进程不崩、可继续响应。④ §2.3a ready 判定事件序实测固化 |
| §4 usage.sqlite + §2.2 usage 回读 | **S3** | 单 session 跑 ≥2 轮：message_end.usage 与 get_session_stats 交叉一致；**cacheWrite 档位与 Usage.cost 单位实测确认**（回改 §4 并记修订如有出入）；`set_auto_retry` 行为确认；`PI_CODING_AGENT_DIR`+models.json 自定义 provider 链路实测（含 agent 目录重定向的容器内叠加影响）；入库可查；若 OpenAI 兼容自定义端点 cost 恒 0 → 记录「token 预算兜底」风险（P3） |
| §1 P-3 容器化驱动 + §3.4 挂载表 | **S4** | docker run 起 pi RPC 容器 + §3.4 全部挂载 + stdin/stdout 通透 + **session 文件落在宿主侧**（容器销毁重建后 switch_session 接续）+ 无 Docker 时启动被拒（fail-closed） |

任一失败 ⇒ 暂停产品开发（PRD §6 硬闸门），回改本文档对应章节。

## 修订记录

- 2026-11-05 v0.1：初稿（S1 结论落文 §2；M0-S2/S3/S4 判据固化 §9）。
- 2026-11-05 v0.2：gstack-spec 审讯四决议落文——D1 `message_bot` 走
  extension_ui 桥（新增 §3.1）；D2 workDir 双卷拓扑（Bot 私有 + Room 共享，
  §4）；D3 全局 review 专用模型槽位（§4）；D4 乒乓守卫 N=4 / 应答超时
  180s（§6.1）。补缺口：budget `maxWallMs`；补群聊上下文渲染格式草案（§5.1a）。
- 2026-11-05 v0.3：循环审计第 1 轮（GLM-5.3:max 独立审计）3 P1 + 8 P2 +
  4 P3 全量处置——P1：新增 §3.2 Chief 管理通道与首启 bootstrap、§3.3
  provider key 存储与注入、§3.4 容器挂载表（session 宿主持久化）；P2：
  §2.3a RPC spawn 契约、§5.1a 渲染矛盾修正、usage kind 判定规则 +
  cache_write_1h 列 + cost 换算与对账闭环、@派活接入 handoff 工作树、
  rooms 级预算字段、S2 判据加结构化桥往返与长时 park、reviewModel 走
  PRD v1.3 修订（见 PRD 修订记录）；P3：预算窗口语义（§6.1a）、rooms
  goal 缓建标注 + messages.jsonl 消息流、依赖图补 turn-engine→driver 直边、
  OpenAI 兼容端点 cost 目录价风险入 S3 判据；§7 补 settings/bot 改停/
  消息回放路由。
- 2026-11-05 v0.4：循环审计第 2 轮（15/15 处置验证通过、无新 P1）4 P2 +
  7 P3 处置——P2：自定义 provider 配置链路（§3.3 schema 扩 baseUrl/models +
  §3.4 pi-conf 挂载行）；messages.jsonl 写者归属与单写者表述修正（§3/§4
  目录树）；§7 补 POST /api/rooms + PUT /api/budget/:scope + stop/delete
  分离；M1/M2 gate 默认档与全 gate 确认兜底（§5.4）。P3：文档头 PRD 版本
  跟 v1.3；宿主/容器路径换算规则（§3.4）；补账水位持久化约束 + memory-
  review 载体方向（§4）；§5.1a 增量注入 + 记忆注入位置；群级预算超限时序
  （§5.3）；get_state/set_auto_retry 纳入实测点名（§2.3a）；PRD §9 命名
  对齐（v1.4）。
- 2026-11-05 v0.5：循环审计第 3 轮**宣布收敛**（11/11 验证通过、无新
  P1/P2、M0/M1 双就绪），8 项 P3 一次关闭——文档头版本同步；§3.3 点名
  `PI_CODING_AGENT_DIR`+`models.json` 公开面与 `$ENV` 插值（审计员独立
  取证核证）；§3.2 工具集补群管理（update/pause/delete_room）+ 单聊=单成员
  room 拍板；§4 sessionPath 示例改绝对路径、rooms paused 状态语义（运行
  态非 mode 枚举）、memory-review 台账 id 对齐下划线风格；§7 补 GET/
  PATCH/DELETE rooms；§9 S3 判据补 set_auto_retry 与自定义 provider 链路
  实测。状态：待 Felix 终审。
