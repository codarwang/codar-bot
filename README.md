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
codar init --provider openai --model gpt-5.4       # + set key (intl)
# or: codar init --provider zai-coding-cn --model glm-5.3   (CN)
codar providers  # see every built-in preset + what you have configured
codar start      # start the host → open http://127.0.0.1:7600
```

**What you need:**
- Node.js 22.19+
- One AI provider API key (OpenAI, Anthropic, Zhipu/zai, MiniMax, DeepSeek, Groq, or any OpenAI-compatible endpoint)
- Docker optional (stronger per-bot isolation if installed)

## What you get

| Feature | Description |
|---|---|
| **Bot team** | Each bot has its own model, role, memory, and budget |
| **Group chat** | Message the room or @-mention specific bots |
| **Task dispatch** | Bots delegate work to each other via message_bot |
| **Approval gate** | Every write operation requires your approval (Allow / Deny) |
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
codar init --provider openai --model gpt-5.4
codar providers   # built-in presets + your configured keys + models in use
```

Built-in presets: `openai`, `anthropic`, `deepseek`, `zai-coding-cn`,
`minimax-anthropic`, `minimax-cn`, `groq`, `openrouter` — each ships a
default endpoint. Any other OpenAI-compatible relay works too (just name it
and give a `--base-url`). The web workstation's bot form and bot detail
page offer provider/model dropdowns fed by the same list
(`GET /api/providers`); unknown providers and model ids stay free-text.

**No-terminal path:** the web UI covers the whole setup — a first-start
wizard (pick provider → paste key → test → Chief) runs when the team is
empty, and the ⚙ Settings panel adds/changes/removes keys and endpoints,
tests the connection (one `GET {base}/models` request), and sets the
memory-review model. Keys saved there apply to bots at their next start.

To add more keys or point a provider at a custom endpoint, edit
`~/.codar-bot/keys.json` (or use the Settings panel — same file) —
`baseUrl` overrides the preset's endpoint, `api`
selects the protocol (`openai-completions` | `anthropic-messages` | …):

```json
{
  "providers": {
    "zai-coding-cn": { "apiKey": "your-key" },
    "minimax-anthropic": { "apiKey": "your-key" },
    "myrelay": { "apiKey": "your-key", "baseUrl": "https://your-relay.example/v1", "api": "openai-completions" }
  }
}
```

> **openai protocol note:** the `openai` preset speaks `openai-responses`
> (pi's pinned catalog serves all current GPT chat models that way, and
> OpenAI recommends Responses for reasoning models). This only shapes the
> models codar generates entries for; to pin an older completions-only
> model, set `"api": "openai-completions"` in its keys.json entry — for a
> catalog-served model you must declare it explicitly in `entry.models`
> with its `api` instead.

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

## Non-affiliation

codar-bot is an independent community project. It is **not** affiliated
with, endorsed by, or sponsored by earendil-works or the pi project.

## License

Apache-2.0
