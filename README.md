# codar-bot

**A home for your bot team on the pi runtime.**

Self-hosted, bring-your-own-model, chat-style multi-bot collaboration: a
Chief bot plus role bots, group rooms, task handoffs, and memory — with
per-bot budgets, tool-call approvals, and an append-only audit trail.

> **Status: early development.** Not yet usable. The CLI, HTTP API, and data
> layout will change without notice.

## What it will be

- A single-user, self-hosted daemon (`codar`) with a thin Web UI
  (localhost / LAN / Tailscale)
- Chat-style teamwork: one Chief bot + role bots (research, writing, …),
  group rooms with a real turn-taking engine, task handoffs with cycle
  prevention, three-scope memory (bot / room / team)
- Governance as the differentiator: per-bot / per-room token & cost budgets
  that stop bots when exhausted, tool-level approvals, an append-only audit
  timeline
- Every bot is a [pi](https://github.com/earendil-works/pi) session: your
  keys, your machine, your data (`~/.codar-bot/`), no telemetry by default

## Non-affiliation

codar-bot is an independent community project. It is **not** affiliated
with, endorsed by, or sponsored by earendil-works or the pi project.

## 许可 / License

Apache-2.0
