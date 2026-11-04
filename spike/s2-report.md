# M0-S2 Spike Report — workeros-gate port to pi 1.5.0

Date: 2026-11-04T18:06:47.870Z
Extension: extensions/codar-gate/codar-gate.ts (donated from workeros-gate, PRD §14)
pi: 1.5.0 (managed install) · provider: configured default (zai-coding-cn/glm-5.3, thinking=low)

## Verdicts

### ✅ ①b write approved ⇒ file written with exact content + audit persisted
- out.txt content ok: true
- audit approval{approved:true, waitedMs≥park}: true
- approvals: [{"kind":"approval","ts":"2026-11-04T18:06:22.703Z","toolCallId":"call_a6b3051840e442a397c80a76","approved":true,"waitedMs":60004}]

### ✅ ③ confirm parked ≥60s; get_state answers mid-park; completes after reply
- parked probe: {"aliveDuringPark":true,"parkedMs":60003}
- settled after late approval: true

### ✅ ④ ready sequence recorded (spawn → first successful get_state response)
- ["response:get_state:ok","response:prompt:ok","event:agent_start","event:turn_start","event:message_start","event:message_end","event:message_start","event:message_end","event:message_start","event:message_update","event:message_update","event:message_update","event:message_update","event:message_update","event:message_update","event:message_update","event:message_update","event:message_update","event:message_update","event:message_update","event:message_update","event:message_update","event:message_update","event:message_update","event:message_update","event:message_end","event:tool_execution_start","ui:confirm","response:get_state:ok","event:tool_execution_end","event:message_start","event:message_end","event:turn_end","event:turn_start","event:message_start","event:message_update","event:message_update","event:message_update","event:message_end","event:turn_end","event:agent_end","event:agent_settled","response:get_last_assistant_text:ok"]
- …criteria ④ detail in spike/s2-report.md

### ✅ ①a write denied ⇒ file NOT written + audit persisted
- confirm request reached host: true
- out.txt exists: false (must be false)
- audit approval{approved:false}: true
- audit lines: 4; last assistant: "The write was blocked by a gate (\"codar-gate: denied by approver, rule preset: write-gate\"), so I could not create `out."

### ✅ ② structured round-trip over ui bridge (params out as placeholder JSON, structured value back)
- ui_request input/codar:bridge-echo seen: true
- outbound placeholder: {"payload":"{\"k\": 42, \"s\": \"中文\"}"}
- payload k/s recognized: true
- marker BRIDGE_ECHO_OK_42 observed in tool result events: true

## ④ Ready sequence (spawn → first successful get_state response)

```
response:get_state:ok
response:prompt:ok
event:agent_start
event:turn_start
event:message_start
event:message_end
event:message_start
event:message_end
event:message_start
event:message_update
event:message_update
event:message_update
event:message_update
event:message_update
event:message_update
event:message_update
event:message_update
event:message_update
event:message_update
event:message_update
event:message_update
event:message_update
event:message_update
event:message_update
event:message_update
event:message_end
event:tool_execution_start
ui:confirm
response:get_state:ok
event:tool_execution_end
event:message_start
event:message_end
event:turn_end
event:turn_start
event:message_start
event:message_update
event:message_update
event:message_update
event:message_end
event:turn_end
event:agent_end
event:agent_settled
response:get_last_assistant_text:ok
```

## Result: ALL PASS — S2 gate OPEN
