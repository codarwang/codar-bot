# Codar Bot

**基于 pi 运行时的 Bot 团队之家。**

自托管、自带 API key、群聊式多 Bot 协作：Chief 调度 + 角色 Bot、群房间、
任务派发、三作用域记忆 — 附带预算熔断、工具审批、追加式审计时间线。

> **状态：M3 开发中。** 产品已可用于个人场景（Bot 团队、群聊、派发、
> 审批、预算、记忆），CLI / HTTP API / 数据布局仍会持续调整。

codar-bot 是独立社区项目，与 earendil-works / pi **无关联**。

## 安装

```bash
npm i -g codar-bot @earendil-works/pi-coding-agent
codar init --provider openai --model gpt-5.4  # + 通过 stdin 输入 key
# 或：codar init --provider zai-coding-cn --model glm-5.3   # 智谱国内
codar providers  # 查看全部内置预设 + 你已配置的 key + 在用模型
codar start     # 启动 → 浏览器打开 http://127.0.0.1:7600
```

**你需要什么：**
- Node.js 22.19+
- 一个 AI provider 的 API key（OpenAI、Anthropic、智谱/zai、MiniMax、DeepSeek、Groq、或任何 OpenAI 兼容端点）
- Docker 可选（装了可开启更强的 per-Bot 隔离）

## 功能一览

| 功能 | 说明 |
|---|---|
| **Bot 团队** | 每个 Bot 有自己的模型、角色、记忆、预算 |
| **群聊** | 发消息到群或 @ 指定 Bot |
| **任务派发** | Bot 之间通过 message_bot 互相派活 |
| **审批门** | 每次写操作需要你批准（允许 / 拒绝） |
| **预算** | 每 Bot / 每群的 token / 费用 / 回合 / 墙钟限额，超限自动停机 |
| **记忆** | Bot 记住历史对话（三作用域：Bot / 群 / 全队） |
| **审计** | 全量审计时间线（每次工具调用 + 审批决策） |
| **实时进度** | 工具活动、回合状态、预算仪表盘实时可见 |

## 界面预览

```
┌─ 花名册 ──┬─ 聊天 ─────────────────────┬─ 右栏 ────────┐
│ ● Chief   │  你：写一首诗              │ 回合          │
│   空闲    │  Chief：正在派发…          │ Chief ▶      │
│ ● Writer  │  Writer：诗来了           │ Writer ⏱ 2m  │
│   干活中  │                           │ 预算          │
│ ◎ default │                           │ Writer 71%   │
└───────────┴───────────────────────────┴──────────────┘
```

## 配置

### Provider

```bash
codar init --provider openai --model gpt-5.4
codar providers   # 内置预设 + 已配置 key + 在用模型一览
```

内置预设：`openai`、`anthropic`、`deepseek`、`zai-coding-cn`、
`minimax-anthropic`、`minimax-cn`、`groq`、`openrouter`——其他任何
OpenAI 兼容中转也能用（自定义名字 + `--base-url` 即可）。Web 工作站的
建 Bot 表单与 Bot 详情页提供同一份数据的 provider/模型下拉
（`GET /api/providers`）；未知名的 provider 与模型 id 仍可自由填写。

或直接编辑 `~/.codar-bot/keys.json`：

```json
{
  "providers": {
    "zai-coding-cn": { "apiKey": "你的 key" },
    "minimax-anthropic": { "apiKey": "你的 key" }
  }
}
```

> **openai 协议说明：** `openai` 预设走 `openai-responses`（pi 钉定版
> catalog 的全部现行 GPT chat 模型都走该协议，OpenAI 官方也推荐
> reasoning 模型使用 Responses）。该设置只影响 codar 生成条目的模型；
> 要固定旧的仅 completions 模型，在其 keys.json 条目里设
> `"api": "openai-completions"`——catalog 内模型则需在 `entry.models`
> 显式声明该模型并指定 `api`。

### 预算

每 Bot 和每群各自的限额（token / 费用 / 回合 / 墙钟）。超限自动停机
并群内广播。

### 审批规则

审批规则控制哪些工具调用需要你批准。通过 `PUT /api/rules` 配置。

### 沙箱

默认审批门控保障安全（与 Claude Code / Cursor 同级安全模型）。已装
Docker 的用户可选开启 per-Bot 容器隔离（更强）。

## 文档

- [English](README.md)

## 许可证

Apache-2.0
