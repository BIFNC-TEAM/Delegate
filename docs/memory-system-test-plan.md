# 记忆系统测试与上线门禁

状态：Web P0 自动化门禁通过；灰度与性能门禁待执行

日期：2026-08-03

对应计划：[记忆系统开发计划](./memory-system-plan.md)

## 1. P0 固定夹具

建立 2 个代表、每个代表 2 个联系人、Web/Matrix/Telegram 三渠道，共 12 个会话单元，并执行 12 × 12 全量交叉查询。Web 是 P0 唯一受支持的长期记忆渠道；Matrix/Telegram 作为不支持渠道验证零召回、零提取和零 Provider 查询。

- 公开知识：只允许当前代表的活动发布版本，当前代表三渠道均可使用。
- 联系人记忆：P0 只允许完全匹配的代表、联系人和来源渠道。
- 代表经验：只允许当前代表、已去标识化且人工审核通过的版本。
- 交易和权限：无论记忆内容如何，始终以实时 PostgreSQL 事实为准。

## 2. 必须覆盖的自动化测试

### 隔离与草稿

- 12 x 12 交叉召回零跨代表、跨联系人或跨渠道联系人记忆泄漏。
- 未发布知识、staging 投影、待审核/隔离/拒绝候选线上召回次数为零。
- 未知 URI、伪造前缀、旧版本和孤儿资源全部 fail closed。

### 安全分类

- 中英文凭据、Token、Cookie、私钥、电话、邮箱、证件、银行卡、地址、商业机密、支付/权益和持久化提示注入语料。
- Owner 私有备注、Compute/Tool 原始输出、Handoff 完成事件不得生成可批准记忆。
- 分类器超时、异常、未知类别全部进入隔离，OpenViking 写入为零。

### 生命周期与权限

- 并发双审只有一个成功。
- 纠正后旧版本立即停止召回。
- 停用/删除提交后立即本地阻断；健康远端物理删除 p99 不超过 60 秒。
- 删除失败保持不可召回并可自动/手动重试；删除证明不含正文。
- Owner/Admin、Reviewer、Operator、Contact、System 的 allow/deny 矩阵全部覆盖，越权响应不得泄露对象存在性。

### 投影、同步与对账

- 部分成功保留成功项，只重试失败项。
- 重复投递、ACK 前崩溃、lease 超时恢复均不产生重复资源。
- 旧 job 晚完成不能覆盖新 active version。
- 精确 URI 对账能发现并安全处理缺失、哈希不一致和旧 active pointer。
- Provider 缺少完整稳定的库存快照/游标时，对账必须标记为 `PARTIAL`，不能宣称远端孤儿、外来对象或重复对象不存在，也不能自动删除未归属对象。
- 只有在 Provider 提供完整库存能力后，才启用远端孤儿发现测试；删除仍须匹配本地权威归属和精确 URI。

### 使用记录与公开来源

- 分别验证 SEARCH_HIT、SCOPE_ALLOWED、SAFETY_ALLOWED、PROMPT_INCLUDED、PUBLICLY_CITED。
- Token 预算丢弃和生成失败不得计为“实际用于回答”。
- 展示来源必须是实际注入集合的子集。
- 使用记录可跳转正确 Inbox 消息，并且普通 DTO 不包含 URI、Layer、Score、Session ID、其他联系人信息或原始 query 副本。

### UI、API 与披露

- 记忆系统不调用 `/training/*`，公开知识只跳知识库。
- 所有私有 API 为 `private, no-store`；列表使用 cursor + asOf，深链刷新后保持筛选和详情。
- 无数据、筛选空、Provider 不可用、部分失败分别有诚实可恢复状态，不出现 Demo 指标。
- Web 首次发送前展示真实的记忆范围、保留期限和删除方式。
- Matrix/Telegram 在具备等价首次发送前披露前，设置、API 和运行时必须统一显示不支持，并保持召回/提取为零。

## 3. 回归与性能

- 运行 OpenViking、web-data、conversation-worker、bot、workflow-runner、Dashboard、公开代表页和 PostgreSQL 集成测试。
- 运行 `pnpm db:generate`、`pnpm db:validate`、全仓 typecheck、test 和 production build。
- 召回 p95 相对 Shadow 基线增幅不超过 20%；Trace 完整率至少 99.9%。
- Provider 超时、限流、损坏数据、数据库短暂断连和 worker 重启时，不发生跨范围泄漏或虚假引用。

## 4. 灰度门禁

```text
Shadow（不注入）
  -> 内部代表 Web
  -> Web 1%
  -> Web 10%
  -> 25%
  -> 50%
  -> 100%

Matrix/Telegram：完成各自首次发送前披露与独立门禁后，再从 Shadow 单独开始
```

任意跨代表/联系人/渠道泄漏、敏感内容注入、删除后继续召回、权限绕过或公开内部字段都必须立即停止灰度。删除与安全过滤不能随功能回滚而关闭。
