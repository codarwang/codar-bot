# M1 收口报告 — 能聊

| | |
|---|---|
| 日期 | 2026-11-05 |
| 判定 | **M1 收口**（§15-4 双 provider 实测按约定挂起，等 Felix key 拍板后补验） |
| Review 纪律 | 与 M0 同流程：每阶段 devin/swe-2:max 循环至 clean —— A 7 轮 / B+C 6 轮 / D 3 轮 / E 3 轮，共 19 轮 |
| 验证 | 74/74 离线确定性测试；tsc 与 web build 双 0 错；真 pi 冒烟 ×2（SMOKETEST / UIWORKS） |

## PRD §6 M1 验收对照

| 项 | 判定 | 说明 |
|---|---|---|
| 1.1 host 骨架 | ✅ | store（原子写/独占锁/迁移/单 Chief）；`npm run host` 起 host+UI；host.json 发现 |
| 1.2 单 Bot 对话 | ✅ | 流式 delta、中断按钮（abort→aborted 事件）、session 持久化+switch_session 恢复、chat 历史加载 |
| 1.3 Bot 管理 | ✅（范围裁剪已记） | API 全字段（name/role/model/thinking/budget/workDir/sandbox）+ UI 建表单；**裁剪**：独立 Bot 详情页 → M2 设计轮交付（现态=roster 行内嵌）；`codar start` 走 npm script，bin 打包 → M3-3.4 |
| 1.4 双 provider | ⏸️ 挂起 | §15-4：等 Felix 手头 key 拍板（本机 zai 已全链验证；deepseek 欠费；§3.3 链路对任意 OpenAI 兼容端点就绪） |
| 1.5 用量记账 | ✅ | usage.sqlite（bot×model×kind）+ Usage 页；USD→micros 实测换算 |

## 交付面

- **host**（零运行时依赖）：store / usage-ledger / bot-manager（epoch 化单飞恢复、失败让渡、settle 三路竞速、§3.3 provider 链、§3.4 docker runner 含双向 session 路径翻译）/ HTTP API+SSE（结构化错误码）/ codar init bootstrap / CLI
- **gate**：codar-gate 扩展（M0 移植，M1/M2 默认档，fail-closed 全路径有测）
- **web**：Vite+React SPA（Overview/Chat/Usage；穿容器审批/流式/历史/用量）
- **测试底座**：fake-pi rpc 桩（含 DIE/SLOW/PARK/斜杠/abort 保真）驱动的 74 个离线确定性测试 + docker 门控测

## M2 带走清单（review 遗留，全部 P3）

1. web：空回复 dedupe 守卫移除（abort/纯工具终态双渲染）、streaming 残标清理（onTerminal 摘泡标志）、切 bot 陈旧异步闭包、Enter 不受 streaming 闸
2. fixture：aborted/errored message_end 文本语义待真机复核（§15-4 时）
3. serveStatic：HEAD 支持；immutable 判定改 served 相对路径
4. npm files 白名单仍为占位（M3-3.4 分发时重排）
5. M0 报告 M1 清单项（容器加固水位、uid 映射、镜像 digest pin 等）继续有效

## 下一步

按 PRD §11/§6：**M1→M2 之间插入 UI 交互设计轮**（产品决策 2026-11-05：设计押后到有活系统+dogfood 痛点后做，主战场为 M2 群聊窗）→ M2 成团（回合引擎/派活/记忆/预算）。§15-4 拍板随时可插队补验。
