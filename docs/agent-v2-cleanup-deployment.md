# V2 清理分支本地部署

2026-10-20（Asia/Shanghai），按用户要求推送 `codex/agent-v2-cleanup` 并部署本机 3002。

- 入口：<http://localhost:3002/reps/founder-representative-2?lang=zh>
- 运行代码：`664905c`，包含清理提交 `db5b53b` 及部署验收发现的 Python 程序失败恢复修复。
- 镜像：`delegate-agent-v2:cleanup-20261020-664905c`。
- 更新服务：Reps、conversation-worker、Compute Broker、Telegram bot。前三项健康/就绪检查通过，bot 运行正常且零重启（未单独配置 Docker healthcheck）。
- 所有新请求统一 V2，主模型 `qwen3.8-27b`，采用已验证的 `qwen-chat-template` 配置；不再读取代表白名单。

## 配置和数据

部署前后逐项比较 190 个代表的设置、发布版本、知识库及能力绑定，均一致。地理代表仍有 7 个知识库绑定、9 个已发布资源、3 个 Skill 和 2 个 MCP。MCP 健康观测字段不作为配置变化。

本次未运行数据库迁移、seed 或知识库重建；未删除历史会话和旧执行记录。验收使用新建匿名会话，其实际请求和回执保留。主工作队列为空时停止旧入口和 worker，先启动新 Broker，再启动 worker、Reps 和 bot，避免两版 worker 同时认领。

运行容器的 7 个关键源文件 hash 与部署代码一致，环境配置逐项核对一致。模型标识、`agentVariant=v2` 和 `runtime=delegate-agent-v2` 从实际 GenerationRun 核验，未仅凭镜像标签判断。

## 验收发现及修复

首次 CSV 请求的模型代码使用 `with csv.writer(sys.stdout) as w`，Python 实际抛出 TypeError：该 writer 不支持上下文管理协议。Broker 已收到非零退出的终止回执，未生成交付文件，但旧包装层仍按未知写入状态停止。

修复只涉及通用工具契约与确定性失败处理：

- 工具说明明确使用 `writer = csv.writer(sys.stdout)` 后调用 `writerow/writerows`，不使用 `with csv.writer(...)`。
- 对已验证的无外部网络隔离 Python，只有同时具备失败回执、`response_received`、`semanticOutcome=failed`、正整数非零退出码、有效结束时间且没有 FILE 产物，宿主才标记 `isolated_program_failed`。
- 主模型在下一次正常响应中决定修正；每次调用计入预算，服务端不自动重试写入。缺失/矛盾回执、未知状态、权限错误或已有交付文件仍走保守停止路径。
- 未向模型输出完整 stderr 或私有输入，未放宽隔离权限，未增加分类、核验或改写模型。

原失败请求 `cmvg13nca0059qw0nmjrnmy0n` 及其历史回复保留，没有改写成成功。

## 最终验证

最终镜像实际 HTTP/SSE 六项检查全部通过：原知识库地图三要素与引用；缺城市先澄清；同会话补充上海后使用原天气 MCP；天气完成后问候；纯翻译；CSV 计算及鉴权下载。问候和翻译均为一次模型、零工具。澄清恢复保留原 task ID。

另外两个独立正常 CSV 请求均一次执行成功；一个显式要求先 `raise ValueError` 的恢复测试，第一次真实失败，主模型修正后第二次成功：3 次模型响应、2 次工具调用，每次各一次实际执行。该定向测试证明恢复机制，不用预设初始失败步骤证明模型自主选择能力。所有 CSV 下载返回 200，解析得到三条原始温度 20、23、26 和平均值 23.0。

修复后定向机制测试 209 项通过，worker/model-runtime 类型检查和容器内 Reps 构建通过。机器可读的请求、模型、来源、调用和下载证据见[部署验收记录](../reports/agent-v2/cleanup-deployment-20261020.json)。这些是有限场景验证，不代表所有开放任务或全部渠道流程均已完成验收。

## 回退

私有配置、数据库备份和回退镜像记录位于清理 worktree 的 `.local/releases/v2-cleanup-20261020/`，不进入 Git。`before.compose.json` 使用固定回退标签。旧 bot 原镜像内容已缺失，通过容器文件系统导出/导入保存本地回退镜像，应用环境变量仍由私有 Compose 注入。

回退时先停止新 worker 和入口，再用 `before.compose.json` 对上述四个服务执行 `up -d --no-deps --wait`。不恢复数据库、不覆盖新对话，也不使用 `--remove-orphans` 删除其他渠道服务。
