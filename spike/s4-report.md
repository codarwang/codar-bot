# M0-S4 Spike Report — Docker per-Bot sandbox

Date: 2026-11-04T19:09:05.187Z
Image: codar-bot-sandbox:0.1 (node:24-alpine + pi 1.5.0 pinned, tini PID-1, unprivileged 'node' user)
Mounts (§3.4): work→/home/bot/work · shared→/home/bot/shared · pi-conf→/state/pi-conf (agent dir, models.json + sessions) · sessions→/state/sessions · codar-gate→/opt/codar-ext:ro
Note: sessions land under the pi-conf mount (PI_CODING_AGENT_DIR=<agentDir>/sessions) — §3.4's separate sessions row is satisfied by the pi-conf mount carrying them; the standalone /state/sessions bind is reserved for M1 layout.

## Verdicts

### ✅ ① containerized pi RPC: mounts live, ui-bridge approval through the boundary, gated write lands HOST-side
- out.txt on host (content s4-hello): true (/var/folders/zy/yzmjw5vn0lg2d3sjlwlhmnlm0000gn/T/codar-s4-erJ1ek/work/out.txt)
- gate audit file written: true (host-visible)
- stdin/stdout JSONL transparency: proven by the approved-write round trip itself

### ✅ ② session persists HOST-side; fresh container resumes via switch_session (context survives)
- session files host-side: 1 (--home-bot-work--/2026-11-04T19-08-49-442Z_01a1a7f6-c3a2-76c6-a673-72d0c9ab14b1.jsonl)
- switch_session(containerPath): true
- container B recall answer: "BANANA-7"
- failures: 0

### ✅ ③ fail-closed: missing docker binary AND unreachable daemon both refuse to start
- missing binary ⇒ start refused: true
- unreachable daemon (DOCKER_HOST=tcp://127.0.0.1:1) ⇒ start refused: true

## Result: ALL PASS — S4 gate OPEN
