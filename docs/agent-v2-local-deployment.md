# V2 本地部署记录

2026-10-19，分支 `codex/agent-architecture`，worktree `/Users/neo/.codex/worktrees/agent-v2/Delegate`。

## 验收入口

- 聊天：<http://localhost:13002/reps/agent-v2-acceptance>
- [10 个测试用例、固定知识答案与判定标准](agent-v2-local-acceptance.md)
- 主模型：用户提供端点的 `qwen3.8-27b`，`DELEGATE_V2_REASONING_PROFILE=qwen-chat-template`。
- 独立 Compose 项目：`delegate-agent-test`。Reps `13002`、Broker `14010`、worker `14040`；本次应用端口绑定 loopback。
- 既有测试基础设施：Postgres `15432`、OpenViking `11933`、对象存储 `19000`。原本机 `3002`/`5432` 服务没有切换。

测试代表使用独立 Owner 和已发布版本，访问免费。企业制度是合成测试数据，天气走真实 Open-Meteo MCP。代码执行/文件写入保持 deny；未将未验证的沙盒能力包装成可用。

## 部署内容

镜像：`delegate-agent-v2:20261019-local`。应用服务统一使用当前开发线构建产物，去掉旧测试栈中指向另一工作区的源码挂载，修复 Broker 因旧包缺少导出而反复重启的问题。

私有操作文件位于 worktree 的 `.local/releases/agent-v2-20261019/`，被 Git 忽略。该目录含密钥配置与数据库备份，不应上传或复制到公开报告：

- `compose.json`：当前实际部署配置。
- `before.compose.json`：部署前配置和镜像记录。
- `before-database.sql`：迁移前独立测试库备份。
- `Dockerfile`、`Dockerfile.trace`、`build-final.log`、`build-trace.log`：本地构建及最后的 worker 任务标识修复层。
- `host-environment.json`：仅供本机初始化的环境，权限 `0600`。
- `smoke-*.json`：真实 HTTP/SSE 自检记录，包括定位问题时的失败记录。

测试库补齐了 6 条项目已有迁移：默认知识启用、退役会员计算门槛、代表行为配置、执行来源回执、逻辑动作身份、MCP provider operation。没有清库。依赖启动期间旧 seed 检测到已有 demo 并跳过；新增验收数据由 `scripts/agent-v2-local-seed.ts` 单独创建，脚本拒绝开发库 `5432` 和非指定测试库。

企业资料通过正式发布与 OpenViking 同步生成 4 个版本资源（身份、FAQ、材料、制度聚合），来源授权和调用记录仍走现有账本；没有向线上 runtime 注入假 RAG 工具或预设回答。

## 实际链路发现并修复的问题

1. **新请求被误判为已运行的旧 Pi 请求。** 入队时写入 `piExecutionProtocol=goal_v2`，而 V2 版本固定逻辑将该字段视为旧执行痕迹。新入队/修订替代请求现在保持空上下文，由首次 worker 租约固定 runtime；已有旧流程、审批和显式版本继续保留。未启用 V2 时仍由旧 worker 路径固定 `goal_v2`。
2. **澄清恢复被授权校验拒绝。** 原问题同时出现在最近历史和等待任务记录中。现在按同一消息 ID 去重后提交授权校验；如果两处文本不一致，继续拒绝，不绕过编辑、撤回或作用域边界。
3. **真实 RAG 被旧语义过滤误挡。** 旧查询分类/中文合词/关键词覆盖过滤会把“年假天数及适用条件”排除。V2 使用显式 `model_selected` 查询模式：保留敏感内容阻断、仅允许已授权公开语料中出现的查询词离开隐私边界，并保留来源命名空间、内容 hash、版本和撤回校验；不走旧业务关键词分类及覆盖比例过滤。返回内容是否相关、充分由主模型决定。旧流程默认行为不变。
4. **完成后的任务标识。** 澄清后的执行完成时继续记录原任务 ID，避免因等待 session 结束而用最后一次请求 ID 替代；累计预算保持原任务口径。

这些修复没有增加分类模型、固定核验链或按业务关键词选择工具的路由。

## 验证

- 定向入口、租约、追踪、RAG 边界及 V2 worker 检查：126 项通过。
- Matrix/入口相关前一轮回归：122 项通过。
- conversation-worker 全量：159 项通过。
- V2 专项：71 项通过。
- web-data、conversation-worker TypeScript 检查通过；Reps 生产构建成功。
- 初始化脚本对开发库地址 `127.0.0.1:5432` 的拒绝检查通过。
- 部署后 Reps、Broker、worker、测试 MCP 容器均通过健康检查；浏览器实际打开验收页面，显示测试代表和可用输入框。

真实 HTTP/SSE 自检使用匿名访客的正常会话、当前记忆告知凭据、排队、worker 和消息交付。数据库复核 `agentVariant=v2`、`agentTrace.runtime=delegate-agent-v2`、`model=qwen3.8-27b`，没有用旧流程结果冒充 V2。

核心链路实测：无城市先等待用户；补充上海后成功查询实际天气，完成记录保留原任务 ID 与累计预算；知识题回答 12 天及试用期限制并给出来源；内部奖金缺失时说明限制且不索要工号/手机号。全部 10 个用例（11 次请求）的部署自检明细见[真实请求记录](../reports/agent-v2/local-deployment-smoke.json)。用例 1 在最后的任务 ID 记录修复后复测，其余 9 项在该项纯记录修复前执行；没有将旧 Pi 失败数据混入 V2 结果。浏览器还实际发送了知识问题，核验答案、来源与可展开调用过程，见[页面截图](../reports/agent-v2/local-acceptance-ui.jpg)。

这些记录证明请求路径和核心事实，不是自动语义满分。天气的额外出行建议及“傍晚”等细化推断仍须对照预报检查；提及的正式核实渠道也不代表本代理已接入这些系统。人工验收结果留待用户确认，不能宣称所有开放问题或全部生产场景通过。

## 管理与回退

以下命令在 worktree 根目录执行，只操作测试应用服务；`--no-deps` 避免自动重新运行 seed/migrate：

```sh
docker compose -p delegate-agent-test \
  -f .local/releases/agent-v2-20261019/compose.json \
  up -d --no-deps --wait reps compute-broker conversation-worker agent-test-mcp

docker compose -p delegate-agent-test \
  -f .local/releases/agent-v2-20261019/compose.json ps
```

仅切回旧决策流程时，在该私有 Compose 文件中将 worker 的 `DELEGATE_AGENT_VERSION` 改为 `pi`，再用上述 `up --no-deps` 更新 worker。已经固定为 V2 的在途请求仍按原版本收尾。旧镜像/完整配置和数据库备份也已保存，但旧 Broker 原本存在包版本不匹配问题，不建议盲目恢复全部旧服务。任何数据库恢复都应另行明确操作，避免覆盖新验收记录。

此部署只服务本机验收，不是生产发布；支付、生产入口、其他渠道和用户原工作区均未切换。
