# AGENTS.md — Engineering rules for codar-bot

Working on this repo? Read this first. `PRD.md` is the single source of truth
for requirements; changes to it require a dated revision note (see its
revision-log section).

## Hard rules (violating these = repeating the WorkerOS failure)

1. **Scope red lines (PRD §2.2)**: no IM channels (Feishu/Telegram/WeChat);
   no multi-user / multi-tenant; no self-built control plane (no metering
   proxy, no event-sourcing database — audit is append-only JSONL); governance
   beyond budgets is M3+. Every milestone review starts with a self-check
   against §2.2 non-goals.
2. **Never patch pi**: use only pi's public extension surface / SDK. Anything
   pi lacks is built in the host layer, never as a fork or patch of pi.
3. **Pin the pi version** (target 1.5.0). Upgrades require an explicit version
   bump plus a regression gate. pi 1.3→1.5 already drifted APIs once.
4. **M0 is a hard gate** (PRD §6): S1 driver decision / S2 gate port / S3
   usage metering / S4 Docker sandbox. Any failure ⇒ pause product
   development. Do not push through.
5. **Release order is locked** (PRD §11): domains → npm publish → repo →
   M0 → M1 → M2 → M3. Externally irreversible actions (publish / purchase /
   register / repo creation / trademark) always require explicit approval
   from Felix first. Local repo changes may be made boldly.
6. **Never touch WorkerOS** (`/Users/felix/projects/workeros`) or its VPS
   (118.196.23.18). It is a read-only asset donor per PRD §14 (gate extension
   code; budget/sandbox/audit semantics). Do not push its local commits —
   that belongs to Felix.

## Working discipline

- Communicate with Felix in Chinese. Every claim needs evidence:
  read the code, don't trust READMEs or screenshots; say "unverified" when
  you can't verify — never guess.
- Tests: fully offline and deterministic, mock-LLM style (node:test +
  mock-llm, as DS-Bot does). The turn engine, budget accounting, and
  cycle-prevention must have unit tests.
- Commits: Conventional Commits — single-line subject (long is fine, but one
  line) + optional body. Never mention test counts or review rounds in commit
  messages.
- Brand boundary: state clearly in user-facing docs that codar-bot is not
  affiliated with earendil-works / pi. Chinese-language docs use the English
  brand name only (see PRD §4 brand boundary).
