# Codar Bot

**A home for your bot team on the pi runtime.**

Self-hosted, bring-your-own-key, chat-style multi-bot collaboration: a
Chief bot plus role bots, group rooms, task handoffs, and memory — with
per-bot budgets, tool-call approvals, and an append-only audit trail.

> **Status: M3 development.** The product is functional for personal use
> (bot team, group chat, dispatch, approvals, budgets, memory) but the
> CLI, HTTP API, and data layout will continue to change.

## Install

```bash
npm i -g codar-bot @earendil-works/pi-coding-agent
codar init --provider zai-coding-cn --model glm-5.3  # + set key
codar start     # start the host → open http://127.0.0.1:7600
```

**What you need:**
- Node.js 22.19+
- One AI provider API key (Zhipu/zai, MiniMax, or any OpenAI-compatible endpoint)
- Docker optional (stronger per-bot isolation if installed)

## What you get

| Feature | Description |
|---|---|
| **Bot team** | Each bot has its own model, role, memory, and budget |
| **Group chat** | Message the room or @-mention specific bots |
| **Task dispatch** | Bots delegate work to each other via message_bot |
| **Approval gate** | Every write operation requires your approval (Allow / Deny / Always allow) |
| **Budget** | Token / cost / turn / wall-time limits per bot and per room, with auto-stop |
| **Memory** | Bots remember past conversations (three scopes: bot / room / team) |
| **Audit** | Full audit trail of every tool call and approval |
| **Live progress** | Real-time tool activity, turn status, budget meters |

## Screenshots

```
┌─ ROSTER ──┬─ CHAT ────────────────────┬─ CONTEXT ────┐
│ ● Chief   │  You: write a poem        │ TURN         │
│   idle    │  Chief: dispatching…       │ Chief ▶     │
│ ● Writer  │  Writer: here's the poem  │ Writer ⏱ 2m  │
│   working │                           │ BUDGET       │
│ ◎ default │                           │ Writer 71%   │
└───────────┴───────────────────────────┴──────────────┘
```

## Configuration

### Providers

```bash
codar init --provider zai-coding-cn --model glm-5.3
```

Or edit `~/.codar-bot/keys.json`:

```json
{
  "providers": {
    "zai-coding-cn": { "apiKey": "your-key" },
    "minimax-anthropic": { "apiKey": "your-key" }
  }
}
```

### Budgets

Per-bot and per-room limits (tokens, cost, turns, wall time). Over-limit
bots stop automatically, with a broadcast to the room.

### Rules (approval shortcuts)

Approval rules control which tool calls need your permission. Configure
via `PUT /api/rules`.

### Sandbox

By default, bots run as local processes protected by the approval gate
(same security model as Claude Code / Cursor). If Docker is installed,
you can optionally enable per-bot sandboxing for stronger isolation.

## Documentation

- [中文文档](README.zh-CN.md)
- [Architecture](docs/architecture.md)
- [M3 Design](docs/m3-architecture.md)
- [PRD](docs/PRD.md)

## Non-affiliation

codar-bot is an independent community project. It is **not** affiliated
with, endorsed by, or sponsored by earendil-works or the pi project.

## License

Apache-2.0
