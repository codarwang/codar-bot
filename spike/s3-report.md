# M0-S3 Spike Report — usage metering

Date: 2026-11-04T18:45:29.648Z
pi: 1.5.0 · providers: zai-coding-cn/glm-5.3 (main) + deepseek via custom chain
cost unit read: USD-decimal (values < 1 ⇒ architecture §4 micros conversion round(usd*1e6) applies)

## Verdicts

### ✅ ③ set_auto_retry off/on round-trip at response level
- set_auto_retry(false): true
- set_auto_retry(true): true

### ✅ ① message_end.usage sums == get_session_stats (tokens + cost)
- assistant usage reports: 2 (need ≥2)
- sum  input=141 output=9 cacheRead=24704 cacheWrite=0 cost=0.00666004
- stat input=141 output=9 cacheRead=24704 cacheWrite=0 cost=0.00666004
- tokens match: true; cost match: true

### ✅ ② usage field reality: cacheWrite1h presence, cost unit, totalFromProvider
- usage reports with cacheWrite1h: 0/2 (provider-dependent; zai/glm may not report)
- cost.totalFromProvider=true: 0/2
- per-message cost.total: [0.00331732,0.00334272]
- cost unit read: USD-decimal (values < 1 ⇒ architecture §4 micros conversion round(usd*1e6) applies)

### ✅ ④ custom provider chain drives a real OpenAI-compatible call
- PI_CODING_AGENT_DIR redirect + models.json + $S3_TEST_KEY interpolation: worked end-to-end
- usage reports: 1; cost.totals: [0]
- cost=0 on custom endpoint ⇒ TOKEN-BUDGET FALLBACK risk recorded (§4: cost budgets degrade to token budgets for unpriced custom endpoints)

### ✅ ⑤ usage.sqlite §4 schema ingests and queries back
- rows ingested: 2; aggregate input=141 output=9 cost_micros=6660
- expected input=141 output=9 cost_micros=6660

## Result: ALL PASS — S3 gate OPEN
