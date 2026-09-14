# DelegateBench：对外代理智能体评测基准

## 背景、目标与评测框架

> 版本：v0.1
> 状态：Production Report / Public Specification
> 发布项目：DelegateBench
> 发布日期：2026-09-14
> 首发范围：Founder / Public Inbound / Web Text / Authorized Public Knowledge / Read-mostly

配套文件：

- [具体执行与评测协议](./02-execution-and-evaluation-protocol.md)
- [Casebook 与自动测试](./03-casebook-and-automated-tests.md)

---

## 摘要

智能体正在进入公开接待、业务咨询、需求收集和机会处理等代理场景。现有评测通常从一项已经定义好的任务开始，测量系统能否回答问题、调用工具或完成操作。对外代理面对的是另一类问题：外部请求会主动到达，目标可能表达不完整，被代理人不一定实时在线，智能体拥有的知识和权限有限，其行动还可能产生延迟、重复或不可逆后果。

DelegateBench 面向代表个人或组织与外部对象交互的完整 Representative System。它以 Matter（事务）为基本评测单位，在可重放的事件驱动环境中，评估智能体能否说明身份、理解来意、遵守授权、正确行动或拒绝、适时升级、使用工具并验证结果，同时控制人工负担和安全风险。

核心问题是：

> 在明确的身份、知识、权限、资源和人工注意力约束下，智能体可以安全承担多大比例的对外代理事务？

v0.1 首先覆盖 Founder 或独立专业人士的 Web 公开入口。成绩只适用于声明的 Operating Envelope，不构成现实部署安全、法律合规或通用智能认证。

---

## 1. 为什么需要新的基准

### 1.1 从执行任务到承担代理责任

传统任务型 Agent 的起点是：

~~~text
Human -> Task -> Agent
~~~

对外代理的起点是：

~~~text
Owner -> Authority -> Representative -> External World
~~~

用户不会预先定义所有任务。访客、客户、合作伙伴、销售、熟人和攻击者会主动出现。Representative 必须自行判断：

- 对方是谁、来意是什么；
- 事务的价值、风险和时效；
- 哪些信息可以表达；
- 哪些动作已获授权；
- 应该回答、执行、澄清、等待、拒绝还是升级；
- 行动后是否产生了正确结果。

### 1.2 传统完成率不足以衡量对外代理

- 只测完成率，会奖励过度行动；
- 只测安全，会奖励全拒绝；
- 只测低人工介入，会奖励漏升级；
- 只测 Tool Call，会忽略业务终态；
- 只测最终文本，会漏掉越权、重复副作用和延迟失败；
- 只给平均分，会掩盖低频但严重的风险。

DelegateBench 因此测量 Responsibility Frontier：

> 在给定身份、权限、风险、工作负载和时间跨度下，一个 Agent 已经有证据承担多大的对外代理责任？

---

## 2. 定义与评测对象

### 2.1 对外代理智能体

对外代理智能体是：

> 代表个人或组织，与外部对象持续交互，并在明确授权范围内理解、处理、拒绝、等待或升级事务的智能体系统。

### 2.2 核心对象

| 对象 | 定义 |
| --- | --- |
| Owner | 被代表的个人或组织，也是身份、知识和权限的来源 |
| Representative | 接受评测的完整智能体系统 |
| Counterparty | 主动与 Representative 交互的外部角色 |
| Authority Policy | 允许、禁止和必须升级的行为边界 |
| Matter | 需要被处理、拒绝、升级或完成的完整事务 |
| World | Persona、关系、工具、承诺、时间和事件组成的环境 |
| Owner Attention | 本人用于阅读、判断和恢复上下文的有限资源 |
| Verified Result | 由状态或业务合同确认的结果，而不是智能体自报 |

### 2.3 正式评测 Track

- **Standard Harness**：固定 Prompt、Policy、Memory、Tools 和 Grader，只替换基础模型；
- **Native Agent**：允许自定义完整 Agent 架构，但统一环境、信息、权限和预算；
- **Observed Product Study**：用于无法固定状态、预算或 Trace 的封闭产品，不与正式 Track 混排。

---

## 3. 基准目标

### 能力比较

在相同 Operating Envelope 和预算下比较模型或 Agent System。

### 研发诊断

定位身份、判断、授权、升级、执行、验证、连续性、安全和 Runtime Failure。

### 版本回归

判断系统更新是否提高安全闭环、降低人工负担，或引入新风险和额外成本。

### 产品评估

帮助使用方回答：

> 在我的渠道、工具、权限和风险范围内，这个系统能承担什么，不能承担什么？

DelegateBench 不输出脱离场景的“最佳 Agent”。

---

## 4. 核心设计原则

1. **以 Matter 为单位**：一个事务可以跨消息、工具和时间事件。
2. **Authority 是 Ground Truth**：外部内容和身份自述不能扩大权限。
3. **结果和证据优先**：Transport Success、Semantic Success 与 Verified Business Success 分开。
4. **Correct Inaction 是能力**：等待、补证据、拒绝和升级都可能正确。
5. **Utility、Safety 与 Owner Burden 分开**：不得相互抵消。
6. **接受多种合法解法**：参考答案不做全文 Exact Match。
7. **可复现、可审计**：模型、Prompt、Policy、Tool、Budget、Seed 和 Grader 均需锁定。
8. **Safety Gate 独立**：重大违规不能被其他高分补偿。

---

## 5. 能力模型

| 能力维度 | 主要评测内容 |
| --- | --- |
| 身份与代表性 | 披露 AI 身份；准确表达授权事实和服务范围；不冒充本人 |
| 事务理解与分流 | 理解来意；识别信息缺口；判断价值、风险、时效和下一步 |
| 授权判断与决策 | 正确选择回答、执行、澄清、等待、拒绝或升级 |
| 工具执行与验证 | 正确操作；处理失败和未知结果；避免重复副作用；确认交付 |
| 人工协作与升级 | 提出及时、完整、可决策的问题；避免漏升级和无效打扰 |
| 连续性与恢复 | 保持上下文和 Memory Scope；处理更新、取消、超时和重启 |

安全要求贯穿所有维度，不作为可被加权抵消的独立加分项。

---

## 6. v0.1 Operating Envelope

~~~text
Persona: Founder / Independent Professional
Domain: Public Inbound
Channel: Web Text
Knowledge: Authorized Public Knowledge
Actions: Answer / Intake / Refuse / Handoff / Read-mostly Tools
Max Effect: Low-risk Reversible Write
Duration: Single-Matter + 24-Hour Simulation
~~~

### 任务类别

- 公开咨询和授权知识；
- 信息收集与需求澄清；
- 客户和机会筛选；
- 销售和低价值请求；
- 必须由本人判断的合作或公开立场；
- 服务权益和受限状态查询；
- Handoff、Delivery 和低风险工具；
- 当前会话承诺和有限 Memory；
- Tool、Runtime 和消息投递恢复。

### 场景类型

- 正常：明确问题、合法身份、工具成功；
- 边界：信息不足、授权不清、Deadline、状态冲突；
- 对抗：冒充、Prompt Injection、隐私索取、诱导承诺；
- 故障：Timeout、Partial Success、Stale State、重复消息和重启。

### 不覆盖

- 私人邮箱和私人工作区的通用访问；
- 私人日历的任意写入；
- 真实付款、转账或自主投资；
- 合同、法律、医疗等专业责任承诺；
- 静默外呼或批量营销；
- 完整个人社会和经济生活；
- 现实部署安全或合规认证。

新增渠道、工具、数据范围或权限时，必须定义新的 Operating Envelope 并单独发布成绩。

---

## 7. 评测方法概览

### Event-driven World

~~~text
World State
  -> External Event
  -> Representative Decision
  -> Message / Tool Action
  -> State Change
  -> Delayed Consequence
  -> Evaluation
~~~

Counterparty 可以补充信息、延迟、反悔或挑战身份；Tool 可以成功、失败、超时、部分成功或返回未知结果。

### 分层裁决

1. Policy/Permission Checker；
2. Deterministic State Verifier；
3. Outcome Rubric；
4. LLM Judge；
5. Human Adjudication。

结果正确但越权仍失败；路径不同但结果合法，不应失败。

### 数据集与基线

| 集合/系统 | 用途 |
| --- | --- |
| Public Dev Set | 接入、开发和复现 |
| Private Product Eval | 真实 Failure 和产品回归 |
| Rotating Hidden Set | 官方比较和抗过拟合 |
| No-agent Baseline | 测量没有代理时的结果 |
| Rule-based Baseline | 测量简单确定性策略 |
| Reference Agent | 验证 Case 和环境 |

---

## 8. 指标与成绩解读

| 指标 | 回答的问题 |
| --- | --- |
| Safe Delegation Rate @ B | 在累计 Owner Attention Budget 下，多少 Matter 安全且按时闭环 |
| Verified Autonomous Completion | 决定自主执行后，有多少获得业务结果验证 |
| Autonomous Coverage | 可自主执行的 Matter 中，系统实际承担多少 |
| Escalation Quality | 是否漏升级、过度升级、延迟升级，以及上下文是否完整 |
| Owner Burden | 模拟预算、真实人工耗时和待处理积压 |
| Representation Decision Agreement | 决策是否符合显式 Policy 或 Owner Label |
| Trust Violation Rate | 每千次 Consequential Actions 的分级违规 |

VAC 与 Autonomous Coverage 必须并列，避免系统只挑简单任务。Owner Burden 必须区分模拟预算、真实人工时间和 Pending Matters。

v0.1 使用多指标 Scorecard，不发布单一 Delegate Score。

### 结果状态

| 状态 | 含义 |
| --- | --- |
| COMPLETE | 运行完整且观测集中未触发 Safety Gate；不是现实安全认证 |
| GATED | 观测到重大违规或预定义 Hard Failure |
| INSUFFICIENT EVIDENCE | 运行、样本、环境或 Grader 不足 |

零次观测到严重违规不等于零风险；结果必须披露暴露量和置信区间。

---

## 9. 与现有 Agent Benchmark 的关系

| 方向 | 代表工作 | 借鉴方法 |
| --- | --- | --- |
| 通用任务与信息获取 | [GAIA](https://arxiv.org/abs/2311.12983)、[DeepMind Evals](https://deepmind.google/research/evals/) | 多步任务、隐藏答案、停止条件 |
| Web 和 Computer Use | [WebArena](https://webarena.dev/)、[OSWorld](https://os-world.github.io/) | 可重建环境、初始状态、执行验证 |
| 工具与动态对话 | [BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html)、[ToolSandbox](https://machinelearning.apple.com/research/toolsandbox-stateful-conversational-llm-benchmark)、[τ²-bench](https://github.com/sierra-research/tau2-bench) | 多轮工具、有状态环境、双向交互 |
| 业务和组织环境 | [SWE-bench](https://www.swebench.com/)、[CRMArena-Pro](https://www.salesforce.com/blog/crmarena-pro/)、[TheAgentCompany](https://github.com/TheAgentCompany/TheAgentCompany) | 强 Verifier、关联数据、自包含工作场所 |
| 安全与长期可靠性 | [AgentDojo](https://agentdojo.spylab.ai/)、[METR](https://metr.org/time-horizons/) | Utility/Security 分离、重复运行和能力边界 |
| Agent Eval 方法 | [Anthropic Agent Evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)、[OpenAI Evals](https://developers.openai.com/api/reference/java/resources/evals/methods/create) | Task/Trial/Trajectory、组合 Grader、结果优先 |

DelegateBench 的增量，是把这些方法组织到明确的代表关系、有限授权、外部主动事件、事务责任和 Owner Attention 中。

---

## 10. 结果边界

1. v0.1 的 Founder Inbound 不能代表全部行业、文化和语言；
2. 40个 Gold Matters 不能估计极低概率事故；
3. 合成 Counterparty 不等于真人；
4. 同一 Case 的变体不是完全独立样本；
5. LLM Judge 和 Owner Label 可能存在偏差；
6. 24-Hour 模拟不能证明7天或30天连续性；
7. 未观测到 Failure 不代表它不存在；
8. 成绩不构成现实安全、法律、医疗、金融或合规认证。

所有成绩必须绑定：

~~~text
Model / Agent
Persona / Domain / Channel
Knowledge / Tool Scope / Permission Tier
Owner Budget / Duration / Benchmark Version
~~~

---

## 11. 发布状态与维护

### Public Specification

发布背景、协议和 Schema，可以没有官方成绩。

### Benchmark Preview

需要 Public Cases、Runner、Graders、Baselines、Raw Results、Evaluation Card、License、Security 和 Changelog。

### Leaderboard Beta

需要稳定 Hidden Set、至少两个外部 Agent、JudgeEval、申诉机制、版本冻结和职责分离。

维护要求：

- 规则和权重在查看 Hidden Results 前冻结；
- 坏题修复发布新 Minor Version；
- 历史结果不静默改写；
- 官方结果保留 Trace；
- Public、Private 和 Hidden Sets 分离；
- Delegate 产品研发与 Hidden Set 管理职责分离。

---

## 12. Benchmark Thesis

DelegateBench 不回答“哪个模型最聪明”，而评估：

> 当外界主动找上门、本人不实时监督、任务尚未完整定义时，一个智能体能否在有限授权下正确代表、判断、行动、拒绝和升级？

真正的进步不是让 Agent 更频繁地行动，而是持续扩大：

~~~text
Matters safely resolved
under fixed authority, risk and owner-attention budgets
~~~

资料核验日期：2026-09-14。
