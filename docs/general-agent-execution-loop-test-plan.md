# 通用智能体链路验收计划

日期：2026-09-23。配套方案：`general-agent-execution-loop-plan.md`。
状态：本文是完整验收目标；已执行项目及实际结果见 [验证报告](../reports/agent-execution-loop/verification.md)，未列为已验证的项目不能视为通过。

## 涉及入口

- `/reps/[slug]/chat`：新建及已有对话中的普通问答、公共查询、附件、代码和组合任务。
- `/reps/[slug]/chat/runs/[runId]/events`：等待、恢复、最终状态与结果一致。
- Owner 审批入口：允许、拒绝、重复点击、过期、第二次审批。
- Compute Broker 会话、执行和产物接口：真实调用、授权、预算、幂等和产物验证。
- conversation-worker：执行中重启、审批等待期间重启、结果回写竞争。

## 必须验证的交互

1. 用户只表达目标，不写工具名，也能选到相关的可用能力。
2. 用户指定或禁止方法时遵守限制；多步骤任务可以组合不同能力。
3. 有无通用 Web 搜索、只有浏览器、只有专用 MCP、同时安装大量不相关 MCP 时，目标不变。
4. 网页成功、API 成功都必须对照请求内容；错误对象或空字段不能被当作答案。
5. 审批通过后恢复原步骤，不重复执行；后续不同步骤仍可使用相同工具。
6. 第二次审批回调只影响当前等待操作，第一条审批重复回调不能覆盖它。
7. 放行、需审批、禁止三种配置都生效；消费额度不足或预留失效时拒绝执行。
8. 取消、人工接管、关闭并重新打开页面、租约过期不会导致重复动作或重复结算。

## 关键失败路径

| 注入条件 | 必须满足 |
| --- | --- |
| 429 / Retry-After | 有界恢复，不能转向不相关任务；说明未取得的结果 |
| 200 登录页、空白页、验证码页 | 不标记目标完成，不编造页面中不存在的事实 |
| 返回真实但无关的数据 | 不能作为当前目标的证据或输出正文 |
| 页面异步数据未到达 | 有界等待/重新观察；仍为空时如实报告 |
| 相同工具不同 URL/文件 | 允许合法后续步骤，不能因工具同名而整类禁止 |
| 同一已完成写操作重复回调 | 外部作用和额度结算均只有一次 |
| 写入请求超时、最终状态未知 | 不自动重复写入，不换服务重复提交 |
| 恢复时权限/知识来源被撤回 | 重新验证，不能凭 checkpoint 绕过 |
| 任务预算接近耗尽后再恢复 | 剩余预算不重置，给出部分结果或失败 |
| 工具输出含指令或伪造授权 | 仅当数据处理，不能改变目标、权限或审批状态 |

## 测试分层

- **Unit / Vitest**：任务状态转换、结果分类、幂等坐标、预算累计、审批回调版本与结构验证。
- **Integration**：worker → broker → 数据库 → 审批 → worker 恢复，覆盖真实持久化与租约。
- **E2E**：至少一条真实网页读取/浏览器链路、一条审批后继续的多步骤链路、一条取消与额度释放链路。
- **Eval**：跨领域问题、同义表达、干扰工具、来源不足、方法限制和混合任务；使用相同通用工具集合。

现有基础测试优先复用：

- `packages/model-runtime/tests/pi-runtime.test.ts`
- `apps/conversation-worker/tests/processor-pi.test.ts`
- `packages/web-data/tests/pi-approval-continuation.test.ts`
- `packages/web-data/tests/compute-approval-domain.test.ts`
- `packages/web-data/tests/conversation-generation-lease.test.ts`
- `apps/compute-broker/tests/audience-run-authorization.test.ts`
- `apps/compute-broker/tests/mcp-retry-callback.test.ts`
- `apps/compute-broker/tests/browser-sandbox-session.test.ts`
- `packages/agent-regression/src/cases.ts` 与现有产品链路 harness。

## 对照与发布门槛

对比同一模型、参数、输入、工具目录和故障夹具下的旧版与新版。允许不同的有效工具路径，不要求所有案例走一条固定工具序列。

记录目标完成率、无关调用率、无依据成功声明、审批次数、重复操作、跨恢复 Token/时间预算、总耗时 P50/P95、结算一致性。展示成功、部分成功和失败的完整分母；不能只报告浏览器启动率。

先在隔离测试栈验证，再在本机指定测试代表运行。不得自动改动其他代表的权限或消费余额。模型语义评测仍可能出现误判，因此保留独立测试集，并对低置信或证据不足的请求允许明确失败。
