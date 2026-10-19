# Agent V2 清理与切换

2026-10-19。从 `origin/dev` 的 `d8818c6` 创建 `codex/agent-v2-cleanup`。V2 验收后，按本次明确选择，统一所有新请求使用 V2，删除旧编排。此分支不自动部署，不修改数据库、代表配置、知识库或用户历史。

## 当前执行入口

- `apps/conversation-worker/src/processor.ts`：认领租约、人工接管、确定性取消/记忆控制、版本固定与唯一 V2 入口。
- `processor-v2.ts`：额度、发布策略、授权上下文、澄清恢复、PI 原生循环及最终保存。
- `agent-capabilities.ts`：授权知识检索、具体 MCP、Skills、隔离 Python/浏览器和文件交付契约。仅保留模型选择查询、参数和下一步的路径。RAG 层不再保留业务关键词分类、预探测路由或相似主题语义门槛；个人信息最小化、语料授权、来源 hash/撤回及租户边界照常执行。
- `generation-lease.ts` / `generation-delivery.ts`：租约、取消信号和 Web/Matrix/Telegram 的交付栅栏，保留未知发送结果禁止盲目重试的行为。
- `attachment-inputs.ts`：附件选择及真实路径读取检查；不再生成固定业务计算脚本。
- `packages/model-runtime/src/v2/`：唯一 Agent 编排。`src/pi/` 只保留已核实的 PI provider、类型和追踪设施。

Telegram 普通消息只入共享队列，删除被 worker 模式屏蔽的旧分类/采集/直接回答分支。显式渠道命令、支付确认、身份及记忆控制保留。无持久化的公开演示入口也改用无工具的 V2，不能冒充知识查询或执行。

## 删除范围

删除旧 PI 的 runtime、tool builder、执行状态机、关键词预取、simple/selective-text 分流、来源语义判定、固定核验/改写、重复规划及原始调用录制器；删除旧 worker 审核预览和固定表格恢复程序。删除更早的直接回答生成器及专用提示词、引用编译器和独立自然语言沙盒编译器。

更早的 `runtime/inquiry-routing` 业务关键词路由、子代理分派、工具指令正则和历史问答路由也已删除；仅保留存储合同类型及明确取消命令。历史 intake 解码/展示保留，自动启动和推进采集的旧决策移除。

旧 `packages/agent-regression` 执行器、单独 reviewer/grounding/latency 实验及仅覆盖旧实现的测试一并移除。仍被验收 Compose 使用的 MCP fixture 服务迁至 `scripts/agent-test-mcp-server.ts`，保留实际用途。当前评估使用 `pnpm eval:agent:v2 --live`；旧 `--compare` 明确报错，避免意外调用已退役循环。

旧架构流程、整改排期及 V3/旧 PI 运行手册不再作为当前文档保留。历史验收原始结果仍在 `reports/agent-v2`；较早 V2 部署文档保留时间和失败证据，并标明其白名单/旧入口说明属于当时版本。

## 历史数据和权限

没有 schema 迁移或数据删除。现有身份、租户、代表版本、知识库授权/撤回、账单、MCP 分类、Broker 权限、文件校验及公共来源投影保持生效。`piStream`、`agentTrace`、历史审批 continuation 等数据库字段保留读写兼容，不进行字段重命名或回填。

新任务首次认领固定为 `v2`。显式旧版本、旧执行协议、审批 checkpoint、未标版本的旧追踪/流式状态均视为旧任务：worker 不加载旧内容进入模型、不重放工具，而是记录 `legacy_agent_runtime_retired`，本次直接终止重试并释放尚未使用的预留额度。已经完成且只需投递的历史答案仍走原鉴权及渠道交付路径。

Broker 的历史回执、已获批准/已提交动作及文件权限仍由原执行系统管理；本次不撤销已发生的外部效果。用户重提有副作用的需求前需要查看原回执，不能把“停止旧编排”当成“旧操作没有执行”。

`owner_and_domain` 或 `domain_only` 等原配置要求的专项语义审核仍未接入 V2，因此在模型/工具启动前明确停止，不放宽配置，也不回退旧审核链。V2 仍拒绝需要新审批和未知行为的工具；本次没有增加新的审批恢复协议。

## 配置及上线

`DELEGATE_AGENT_RUNTIME=pi` 表示实际底层框架。`DELEGATE_AGENT_VERSION` 可省略或设为 `v2`，显式其他值会报错。移除 `DELEGATE_AGENT_V2_REPRESENTATIVES`：白名单不再参与选择，所有新请求统一 V2。

V2 模型连接三件套仍须完整配置：`DELEGATE_V2_MODEL_BASE_URL`、`DELEGATE_V2_MODEL_ID`、`DELEGATE_V2_MODEL_API_KEY`。该连接现在供所有新聊天请求使用；不影响独立文档生成的模型配置。worker readiness 与执行使用相同端点解析。预算集中在 `src/v2/config.ts`，模型请求不做隐藏重试。

部署此分支时，先停止旧 worker 认领并等待在执行请求结束，核查待审批及未知回执，再更新同一队列的全部 worker 与 Reps/Broker 到兼容代码。不要让旧版和新版 worker 同时消费队列。此清理不要求数据库迁移，也不要重新 seed 或重建知识库。

日常验证：

```sh
pnpm test:agent:v2
pnpm --filter @delegate/conversation-worker test
pnpm typecheck
# 需要模型凭据，工具为受控模拟数据，明确区别于实际产品链路
pnpm eval:agent:v2 --live --suite=clarification --repetitions=3
```

`test:agent` 和 `test:agent:contract` 指向 V2 机制检查。独立验收 Compose、原测试数据库种子及 V2 本地种子保留。

## 验证记录

- 全工作区类型检查与测试：36/36 个任务成功；16 个测试包共 3433 项通过、292 项需独立环境的测试跳过。删除的旧编排测试不再计入当前覆盖数。
- `pnpm test:agent:v2`：202 项通过；RAG 隐私及授权回归另外 61 项通过。
- `pnpm test:agent:v2:pg16`：可销毁 PostgreSQL 16 上 64 项通过、1 项真实云沙盒检查未启用；全部迁移只应用到该测试数据库，结束后容器已清理。
- Reps 生产构建通过；移除无用包依赖后 model-runtime/bot 类型检查及 frozen lockfile 检查通过。
- `qwen3.8-27b` 真实模型、受控工具三轮共 36 个请求（含 3 次澄清恢复），36/36 目标检查通过；69 次模型响应、39 次工具调用。没有预设模型工具调用顺序，不将这些次数解释为普遍性能提升。

[机器可读验证汇总](../reports/agent-v2/cleanup-validation.json)与[真实模型原始报告](../reports/agent-v2/evaluation-2026-10-19T09-41-58-099Z-43ffb756-e190-405f-a715-e706f95d3d27.json)保留验证条件。真实模型复测使用合成知识/天气/计算工具；本次未重跑生产知识库、MCP 和真实云沙盒全链路，也未部署 `3002`。此前验收次数不替代本分支验证，机制测试不能证明开放任务回答质量。

## 历史实现

删除文件可从清理前提交 `d8818c6` 恢复审阅；最后的 V2 验收实现为 `b52ef1a`。需要重现旧循环对比时，应新建该历史提交的独立 worktree，使用隔离数据库及测试配置，不在当前代码中保留隐式备用循环。

回退使用清理前的完整镜像/代码与对应配置，先停止新 worker；不回滚数据库或覆盖新增对话。已固定为 V2 的任务不能交给不支持 V2 的更早版本。此分支未创建远程部署或自动回退操作。
