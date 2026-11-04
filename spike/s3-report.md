# M0-S3 Spike Report — usage metering

Date: 2026-11-04T18:59:40.625Z
pi: 1.5.0 · providers: zai-coding-cn/glm-5.3 (main) + zai as a CUSTOM provider chain (s3custom)
cost unit read: USD-decimal (values < 1 ⇒ architecture §4 micros conversion round(usd*1e6) applies)

## Verdicts

### ✅ ③ set_auto_retry off/on round-trip at response level
- set_auto_retry(false): true
- set_auto_retry(true): true

### ✅ ① message_end.usage sums == get_session_stats (tokens + cost)
- assistant usage reports: 2 (need ≥2)
- sum  input=141 output=11 cacheRead=24704 cacheWrite=0 totalTokens=24856 cost=0.00666884
- stat input=141 output=11 cacheRead=24704 cacheWrite=0 total=24856 cost=0.00666884
- tokens match: true; cost match: true

### ✅ ② usage field reality: cacheWrite1h presence, cost unit, totalFromProvider
- usage reports with cacheWrite1h: 0/2 (provider-dependent; zai/glm may not report)
- cost.totalFromProvider=true: 0/2
- per-message cost.total: [0.0033247199999999998,0.00334412]
- cost unit read: USD-decimal (values < 1 ⇒ architecture §4 micros conversion round(usd*1e6) applies)

### ✅ ④ custom provider chain drives a REAL successful OpenAI-compatible call
- PI_CODING_AGENT_DIR redirect + models.json + $S3_TEST_KEY interpolation: worked end-to-end
- output tokens: 3; last text: "CUSTOM"; last stopReason: stop; failures: 0
- cost arithmetic: catalog(input×1.4 + output×4.4 + cacheRead×0.26)/1e6 = 0.00312116 vs observed 0.00312116
- custom catalog price IS used for usage cost (calculateCost path confirmed empirically)

### ✅ ⑤ usage.sqlite §4 schema ingests and queries back
- rows ingested: 2; aggregate input=141 output=11 cost_micros=6669
- expected input=141 output=11 cost_micros=6669

## Result: ALL PASS — S3 gate OPEN
