# 地理代表切换 V2：3002 部署记录

> 本文保留该阶段的实际验收记录。当前新请求统一走 V2；旧白名单和回退旧循环的说明仅适用于当时版本，最新入口及部署边界见[清理与切换](agent-v2-cleanup.md)。

最新 worker 部署配置见 [CSV 输出与失败恢复修复](agent-v2-csv-output-fix.md)，保留本页记录的代表配置及此前的上下文修复。

后续已修复“完成天气后说你好又查天气”的上下文问题，当前 worker 配置与新镜像见[当前轮次修复记录](agent-v2-current-turn-fix.md)。下文保留最初切换和配置保留证据。

2026-10-19，按用户明确要求，将现有本机 `3002` 的 `founder-representative-2` 切换为最新 V2，主模型使用用户提供的 `qwen3.8-27b` 端点。

入口：<http://localhost:3002/reps/founder-representative-2?lang=zh>。刷新原页面后发送新消息即可；旧消息和已固定为旧流程的历史运行不会被改写或重跑。

## 范围与配置保留

更新了 Compose 项目 `delegate` 的 Reps、conversation-worker 和 Compute Broker，镜像为 `delegate-agent-v2:geo-3002-20261019`。仅 `founder-representative-2` 在 V2 白名单内。

新增完整的 V2 专用模型连接配置 `DELEGATE_V2_MODEL_BASE_URL`、`DELEGATE_V2_MODEL_ID`、`DELEGATE_V2_MODEL_API_KEY`；只有 V2 工厂读取这些变量。主模型使用 PI 原生 `qwen-chat-template` 配置。旧模型变量、凭据和服务连接保持不变；其他代表的旧 Pi 工厂仍解析为 `qwen-plus`。新端点单价默认为未知，不沿用旧模型计价。

部署前后对以下记录逐项比较，均一致：

- 代表完整设置和当前已发布版本 `cmuzi975r0003r2wpiwfjh9ku`。
- KnowledgePack、7 个知识资产绑定、知识资产内容及 9 个已发布资源。
- 3 个 Skill 绑定、2 个 MCP 绑定的配置。
- 能力权限 profile/rules、记忆策略、回答范围、语言、语气及收费/免费额度配置。

MCP 定期健康检查的时间和状态不属于配置对比；没有修改其服务器地址、工具白名单或审批要求。没有重新 seed、重新发布代表、重建知识库、修改数据库 schema 或切换其他渠道配置。

## 验证

- V2 专项 73 项通过，model-runtime 类型检查通过。
- Reps、worker、Broker 健康检查通过；容器内关键源码 hash 与当前 worktree 一致。
- 容器中的模型工厂核验：V2=`qwen3.8-27b`，旧 Pi=`qwen-plus`。
- 真实 HTTP/SSE 请求的数据库记录均为 `agentVariant=v2`、`runtime=delegate-agent-v2`、`model=qwen3.8-27b`，未观察到旧核验/改写链事件。
- “地图三要素”通过原知识库检索，回答比例尺、方向、图例，并引用《地理_01_地球与地图》。
- “今天气温多少？”先询问城市；同会话补充“上海”后调用原有 Open-Meteo MCP 成功，任务 ID 和累计预算延续。

详细自检及配置保留结果见[部署证据](../reports/agent-v2/geography-3002-deployment.json)。这些是有限的接入检查，不代表所有回答都经过逐句事实验证。

首次启动发现历史 Compose 包含链带回旧开发源码挂载，覆盖了新镜像；已恢复部署前实际挂载状态（Reps/worker 无源码挂载，Broker 保留 Docker socket）并重新部署、自检。第一次走旧模型的诊断请求保留在私有记录中，不计为 V2 成功结果。

## 运行与回退

worktree：`/Users/neo/.codex/worktrees/agent-v2/Delegate`。实际部署和备份位于被 Git 忽略的 `.local/releases/geo-v2-3002-20261019/`。配置、原代表完整快照、数据库备份均仅保存在本机私有文件，不包含在 Git 提交中。

后续更新此部署应使用对应的 Compose 文件，避免旧开发 Compose 再次引入源码挂载：

```sh
docker compose -p delegate \
  -f .local/releases/geo-v2-3002-20261019/compose.json \
  up -d --no-deps --wait reps compute-broker conversation-worker
```

如需恢复原运行镜像与环境配置，使用已保存的 `before.compose.json`，同样只更新上述三个服务、使用 `--no-deps`；该回退不恢复或覆盖数据库。`before-database.sql` 仅作为另行明确执行的数据恢复备份，不能随意覆盖新增对话。

`13002` 的隔离验收栈继续保留；当前正式测试该地理代表应使用本页的 `3002` 原地址。
