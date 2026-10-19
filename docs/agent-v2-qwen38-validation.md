# V2 切换 qwen3.8-27b 与行为复测

2026-10-19，在 `codex/agent-architecture` 的独立 worktree `/Users/neo/.codex/worktrees/agent-v2/Delegate` 中，按用户提供的端点切换为 `qwen3.8-27b`。本地模型配置已实际保存到被 Git 忽略的 `.env`，权限为 `0600`，没有复制原工作区的生产配置。密钥不进入源码、报告或提交。此变更没有部署或替换生产默认入口。

## 连接与必要的能力适配

`GET /v1/models` 返回 200，列出请求的模型 ID；Chat Completions、PI 流式请求、原生工具调用均实测可用。沿用现有 `agicto` 配置槽选择 `openai-completions` 传输；这里的槽名不代表请求发往 Agicto，实际请求使用用户配置的 Base URL，没有备用模型回退。

仅替换 URL、模型 ID 和密钥时，三轮扩展检查为 **33/45**：缺地点 6/12 通过，部分请求直接搜索并采用返回的上海数据；内部未命中 12/12 通过。5 次没有进入等待状态的后续请求记录为 `not_resumed`，没有从统计中删掉。原始[失败基线](../reports/agent-v2/evaluation-2026-10-19T07-11-04-653Z-4f342242-b23b-4db8-97f5-1442dc7f8ae2.json)保留。

读取该端点 `/openapi.json` 后确认它声明 `chat_template_kwargs`、`thinking_token_budget` 和 `include_reasoning`；启用/关闭思考的真实请求分别返回非空/空 reasoning 字段。保留了[接口元数据和探测记录](../reports/agent-v2/qwen38-endpoint-contract.json)，没有保存思考正文。

新增显式 `DELEGATE_V2_REASONING_PROFILE=qwen-chat-template` 配置，复用安装的 PI 0.85.1 原生编码器，发送 `chat_template_kwargs.enable_thinking` 和 `thinking_token_budget`。没有把 Qwen Plus 的顶层参数盲目套给新服务，也没有仅凭模型名称自动判定能力。未知配置或不兼容传输会报错，默认 `auto` 的行为不变。

这是模型能力配置，不是新的决策流程：本次没有改系统提示词、工具选择策略或原生执行循环，没有增加业务关键词路由、分类或固定核验模型。主模型在同一个正常响应中决定是否澄清、检索或回答。

## 三轮结果

相同模型、提示词、工具定义和合成数据，每轮 12 个首次请求 + 3 次恢复，三个独立轮次共 45 个请求，temperature=0。没有给真实模型预设调用序列。每个请求/session ID 独立，保留累计任务预算和实际工具名称。

| 专项检查 | 数量 | 复核结果 |
| --- | ---: | --- |
| 缺地点（原题、短问法、气温、催促直接查询） | 12 | 12/12 先澄清；各 1 次主模型 + 1 次 `request_clarification`，0 次检索/搜索 |
| 内部资料未命中（公司、个人、主动提供标识、英文） | 12 | 12/12 实际检索后说明限制，无无用个人信息请求或编造金额 |
| 已给城市、可信位置、知识命中、纯翻译 | 12 | 12/12；没有退化为一律提问 |
| 澄清后补充城市 | 9 | 9/9 恢复查询并给出来源 |

[原始三轮报告](../reports/agent-v2/evaluation-2026-10-19T07-12-55-701Z-fa98dd1a-9eff-4cc4-9363-d7dee834354d.json)自动评分 **44/45**。其中一句“提供工号和手机号也无法用于查询”被旧离线评分器误判为索要信息；实际是在解释提供也无用。添加该原句、条件式说明及“但请提供手机号”等正反例测试后，离线复核为 **45/45**。原始回答和失败检查没有被覆盖；评分器不参与线上决策。另做该场景[三次新的真实模型请求](../reports/agent-v2/evaluation-2026-10-19T07-15-08-170Z-62d058f6-d80a-40fb-a8d5-b8b7b1e1ba99.json)，**3/3** 通过。

完整核心套件（含覆盖不明、翻译、润色、实时、检索补查、多工具计算、注入文本）[11 个问题 + 1 次恢复](../reports/agent-v2/evaluation-2026-10-19T07-12-55-701Z-fbe07a6d-22ae-4ff9-9a0b-8ddf10edbe14.json)为 **12/12**。早期连接冒烟、未适配的核心结果与适配后的定向探测也保留在 `reports/agent-v2`，未混入最终三轮通过率。

原始文件 hash、分组指标和唯一评分变化见[机器可读汇总](../reports/agent-v2/qwen38-switch-summary.json)。在 worktree 根目录运行 `node --import tsx reports/agent-v2/rescore-qwen38.mts` 可重新生成汇总；它不会调用模型或修改原始报告。

## 资源与性能记录

当前发送的思考预算为 1024 token，包含在每次 2048 输出 token 上限内；保留已有总 token、主动时限、调用数和最终回答保护。真实评估观察到 84 次主模型响应包含 thinking block，报告只记录数量及 usage，不保留其正文。端点不提供独立的思考 token 用量，因此不能仅凭其 schema 声称单独验证了服务端思考预算的精确执行。

| 相同 V2 / qwen3.8-27b 扩展套件 | 未启用原生思考 | 当前原生配置 |
| --- | ---: | ---: |
| 目标检查通过 / 计划请求 | 33/45 | 45/45（复核） |
| 实际执行请求 | 40（5 未恢复） | 45 |
| 实际执行请求耗时中位数 | 0.77 秒 | 1.87 秒 |
| 首次有效输出中位数（36 个首次请求） | 0.80 秒 | 1.98 秒 |
| 模型调用总数 | 73 | 84 |
| 工具总调用数（含澄清） | 40 | 51 |
| 外部工具调用数（去除澄清） | 33 | 39 |
| provider 返回总 token | 212,549 | 269,416 |

当前配置缺地点请求耗时中位数 1.72 秒，内部未命中 3.94 秒，恢复 1.48 秒。内部未命中每题有 1–2 次检索和 2–3 次模型请求，模型有时会更换查询再查一次。没有额外核验/改写请求。

这些数值描述本批样本；核心套件与扩展套件有并行运行，缓存、后端调度和未恢复样本影响比较，不能据此宣称普遍加速或同等任务成本降低。新模型没有重新跑旧架构性能对照；历史 `qwen-plus` 的旧架构/V2 对比不能拿来当本次结论。模型单价未配置，费用为 N/A。

## 本地验证与启动

- `pnpm test:agent:v2`：**69 项通过**，包括新增原生请求字段、显式关闭、旧绑定不变、错误配置拒绝与评分器正反例。
- model-runtime、conversation-worker TypeScript 检查通过。
- 真实模型评估与模拟模型机制测试分别记录；后者不能证明模型自主选择能力。

在上述 worktree 根目录直接运行（根脚本自动加载本地 `.env`）：

```sh
pnpm agent:v2 -- "只翻译成英文：会议改到明天下午三点。"
pnpm agent:v2 --fixture-tools --session .local/qwen38-session.json "今天气温多少？"
pnpm agent:v2 --fixture-tools --session .local/qwen38-session.json "上海"
pnpm eval:agent:v2 --live --suite=clarification --repetitions=3
```

本地非秘密配置要点：

```dotenv
DELEGATE_MODEL_PROVIDER=agicto
DELEGATE_MODEL_FALLBACK_PROVIDER=
DELEGATE_AGICTO_MODEL=qwen3.8-27b
DELEGATE_V2_REASONING_PROFILE=qwen-chat-template
DELEGATE_MODEL_TIMEOUT_MS=30000
# DELEGATE_AGICTO_BASE_URL / DELEGATE_AGICTO_API_KEY 仅在本地忽略文件配置
# THINKING_TOKENS=1024 / OUTPUT_TOKENS=2048 沿用 V2 默认值
```

其他机器或 worker 需显式注入相同模型变量；本地 `.env` 只有模型设置，不含数据库、租约和 Broker 等完整测试栈配置。入口试运行仍需 [V2 双开关及独立服务栈](agent-v2.md)，不会因保存模型配置而切换线上入口。恢复原模型时还需将 `REASONING_PROFILE` 改回 `auto`，避免把本端点参数带到不兼容服务。

## 尚未验证与已知限制

业务、知识和天气数据均为受控合成工具，未执行生产 RAG/MCP/数据库全链路验收。连接只确认端点广告的模型 ID 和实际行为，不能独立核实底层权重版本。

45/45 是上述目标检查通过率，不是所有句子都被来源充分支持。人工检查发现催促出门场景的恢复回答仍会附带“一般不用带伞”等建议，而 fixture 只有当前观测、没有降雨预报；这是尚未解决的额外推断，不能把来源 ID 存在当作这些建议已获证据支持。部分英文问题也会用中文答复。本次没有新增语义审核链去掩盖这些限制。
