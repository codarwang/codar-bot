# M0 硬闸门报告 — pi 1.5.0 成色验证

| | |
|---|---|
| 日期 | 2026-11-05 |
| 判定 | **S1-S4 全部通过 — M0 闸门开放，M1 可以开工** |
| 依据 | PRD §6（S1-S4 任一失败 ⇒ 暂停——无一失败）；架构 docs/architecture.md v0.9a §9 判据；各 spike 报告为证据原件 |
| Review 纪律 | 每个 spike 完成后经 pi(devin/swe-2:max) 循环 review 至 clean：S2 4 轮 / S3 3 轮 / S4 3 轮 |

## 各 spike 结论

| Spike | 判据 | 结果 | 证据 | Review |
|---|---|---|---|---|
| **S1 驱动面定案** | RPC vs SDK：会话生命周期/流式/中断/usage 回读 | **RPC 模式**（`pi --mode rpc` 子进程）：故障域隔离、版本解耦（A7）、扩展面完整、WorkerOS 实战先例；四项能力经协议类型逐字节核实 | 架构 §2；rpc-types.d.ts 逐字节 | （定案轮，未单独循环） |
| **S2 gate 可移植性** | workeros-gate 在 1.5.0 跑通写文件审批；结构化桥往返；60s 长 park；ready 序列固化 | 4/4 PASS：拒绝⇒未写+审计；批准⇒精确落盘 waitedMs=60004；park 期间命令通道存活；`response:get_state:ok` 为首条记录 | spike/s2-report.md | 4 轮收敛（修 1 真 bug：ui 回复 id 被命令关联覆盖） |
| **S3 计量** | 双源交叉一致；档位/单位实测；set_auto_retry；自定义 provider 链路；sqlite 入库 | 5/5 PASS：**零漂移对账**（message_end 之和 == session_stats，全维度）；cost=USD 小数（×1e6 换算成立）；自定义链路真调用成功且**目录价被采用**（cost=0.0159 与 1.4/4.4 精确对应） | spike/s3-report.md | 3 轮收敛（review 拆穿 1 个 P1 假阳性：402 错误路径的全零 usage 曾被误读为「pi 不用目录价」——架构 v0.8 诚实修正） |
| **S4 沙箱** | 容器化 RPC + §3.4 挂载 + 宿主 session + fail-closed | 3/3 PASS：gate 审批穿容器边界、写落宿主；**容器销毁重建后 switch_session 精确接续**（"BANANA-7"）；无 docker/daemon 不可达均拒启 | spike/s4-report.md | 3 轮收敛（挂载表按实测修正为 pi-conf 携带 session） |

## 沉淀的资产（M1 直接复用）

- `extensions/codar-gate/` — gate 扩展（M1/M2 默认档：读 allow/写 gate + 破坏性 bash 模式；fail-closed 全路径有单测）
- `src/driver/rpc-client.ts` — 生产级 RPC 驱动器（byte-split-LF 分帧、有界一切、idle/park/wall 三看门狗状态机、错误映射 bot_failed、SIGTERM→SIGKILL、argvPrefix 沙箱 shim）
- `spike/docker/Dockerfile` — 沙箱镜像（node:24-alpine + pi 1.5.0 pin + tini + 非 root）
- 35 个离线确定性单测（规则引擎/审计/分帧/看门狗状态机/gate handler）

## M0 期实测改写架构的事实

1. `AgentToolResult.details` 在 1.5.0 必填（1.3→1.5 漂移实例，A7 佐证）
2. usage cost 为 USD 小数；errored message_end 携带全零 usage（预算层不得计为消费）
3. 自定义 provider 的 models.json 目录价**会**被采用（v0.7 误判已在 v0.8 修正）
4. session 落 `pi-conf/<botId>/sessions/<项目目录>/`——pi-conf 挂载即 session 载体（§3.4 v0.9）
5. key 经 `$ENV` 插值注入，容器内 auth.json 保持空文件（key 唯一实存 keys.json 声明成立）
6. idle 看门狗须感知审批 park（静默是设计内）；子进程侧超时解 park 需 GC（round-3 修复）

## 带入 M1 的已知清单（review 遗留，全部非阻塞）

- 容器加固水位决议（cap-drop / no-new-privileges / 资源限额 / 网络）——§8
- Linux 宿主 uid≠1000 挂载写权限；镜像 base digest pin + npm integrity
- session 路径确定性来源改用 `get_state.sessionFile`（现为目录扫描）
- S2 review 遗留 4 项 P3（replyUi 可测性、host timeout 校验宽严、park_expired 可观测性、bridgeEcho abort 残留）
- `--no-session` 默认翻转 + `--session` 支持（M1 首日）
- set_auto_retry 语义级验证（现为响应级）

## 下一步

按 PRD §11/§6 进入 **M1 — 能聊**（host 骨架 → 单 Bot 对话 → Bot 管理 → 双 provider → 用量记账）。
§15-4 双 provider 建议（OpenAI 兼容 + Anthropic）待 Felix 手头 key 拍板。
