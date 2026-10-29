# V2 CSV 输出失败与恢复修复

> 本文保留该阶段的实际验收记录。当前新请求统一走 V2；旧白名单和回退旧循环的说明仅适用于当时版本，最新入口及部署边界见[清理与切换](agent-v2-cleanup.md)。

2026-10-19，已更新本机 `3002` 地理代表的 worker。模型仍为 `qwen3.8-27b`，代表知识库、发布版本、工具与权限配置保持不变。

## 原因

截图对应请求 `cmvf01jf8021cru0n5pxoc4op` 已实际进入受限 Python 沙盒，并计算出平均值 23.0。原脚本先执行 `print("average:", avg)`，随后输出 CSV：

```text
average: 23.0
record,temperature_c
day1,20
day2,23
day3,26
average,23.0
```

现有文件交付契约把完整 stdout 保存为声明的文件，不收集程序自行写在沙盒中的任意文件。第一行只有一列，其余 CSV 行有两列，因此被确定性校验拒绝。Broker 回执为 `transportOutcome=response_received`、`semanticOutcome=failed`、`failureReason=output_csv_invalid`，只保存 stdout 审计产物，没有生成可下载文件。[原始失败证据](../reports/agent-v2/csv-output-original-failure.json)已保留。

同时存在两处 V2 接入缺陷：

1. V2 工具描述只说可以执行和生成文件，没有清楚暴露底层“stdout 就是最终文件”的契约。
2. 所有有写入效果的调用异常都被统一视为 `unknown_effect`。即使 Broker 已明确确认文件格式失败，也丢失了具体错误并停止模型循环，因而显示了误导性的“最终状态未确认”。

## 修改与边界

- 由可信宿主提供实际工具说明：当前只支持预检通过的 Python；最多一个 64 KiB UTF-8 TXT/MD/CSV/JSON 文件；stdout 只能包含最终文件内容，日志写 stderr。CSV 建议直接用 `csv.writer(sys.stdout)`，不能额外打印均值说明或空行。
- 对脚本尚未提交的确定性参数/预检失败，宿主明确标为 `not_dispatched`。
- 对受限、无外部网络效果的隔离 Python 已返回终止回执且文件未发布的输出校验失败，宿主明确标为 `isolated_output_rejected`。CSV/JSON/文本/体积失败返回具体原因与修正提示。
- PI 将这些宿主确认的失败作为真实错误工具结果交给主模型，在下一次正常响应中决定修正参数或说明限制。没有自动重试写入，没有增加固定核验或改写模型。
- 未知回执、超时、权限拒绝、结果下载/交付完整性尚未确认等情况仍保守停止。远程 MCP 返回体中的相同字段不能授予重试权限；矛盾的 blocked/unknown 状态优先拒绝。
- 每次模型修正调用都计入模型、工具、尝试次数和总预算；写入仍串行。CSV 校验器、权限和隔离限制没有放宽，也没有通过自动删除日志行来掩盖格式错误。

## 验证

- V2 专项 **90 项通过**。
- conversation-worker 全量 **164 项通过**。
- 文件校验、宿主适配及 V2 执行的前一轮定向检查 **146 项通过**；之后增加的矛盾恢复标记用例也已纳入 V2 专项。
- worker、model-runtime 类型检查通过；部署后关键源码 hash 与 worktree 一致。

实际 `3002` HTTP/SSE、真实模型、真实隔离 Python 和鉴权下载验证：

| 场景 | 结果 |
| --- | --- |
| 原正常需求，独立会话第 1 次 | 一次执行成功，实际下载 200，CSV 60 字节 |
| 原正常需求，独立会话第 2 次 | 一次执行成功，实际下载 200，CSV 60 字节 |
| 刻意先输出错误说明行，再修正 | 第一次真实返回 `output_csv_invalid`；下一次主模型修改代码，第二次执行成功并下载 |

恢复场景为 **3 次正常模型响应、2 次工具调用，每次调用各执行一次**，不是基础设施自动重试。该测试显式要求先制造格式失败，只证明实际错误恢复链路，不用它证明模型自主选择初始调用顺序。前两次正常需求由真实模型自行生成参数。

三份实际下载文件均通过 CSV 解析：一个表头、三条原始气温记录及一个平均值行，数值为 20、23、26、23.0。见[真实执行与下载记录](../reports/agent-v2/csv-output-live-verification.json)和[真实下载内容样例（仓库中统一为 LF 换行）](../reports/agent-v2/csv-output-example.csv)。

原失败请求和历史回复未重写；用户可在原聊天入口重新提交原请求。有限测试不代表任意文件内容和所有程序都必然成功。

## 部署与回退

当前 worker 镜像为 `delegate-agent-v2:csv-output-20261019`。本次不更新 Broker、Reps、数据库或代表设置。

私有配置和回退快照位于 worktree 的 `.local/releases/v2-csv-output-20261019/`。更新此版本使用：

```sh
docker compose -p delegate \
  -f .local/releases/v2-csv-output-20261019/compose.json \
  up -d --no-deps --wait conversation-worker
```

该目录的 `before.compose.json` 可恢复修复前 worker；不要恢复数据库或删除原失败回执。
