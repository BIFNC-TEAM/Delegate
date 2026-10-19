# 腾讯 AGS All-in-One 迁移记录

核查与迁移日期：2026-09-23。

## 目标和本机配置

控制台截图确认目标为广州地域的 Agent Runtime / AGS All-in-One 工具 `delegate-aio-pi-v1`，不是云函数 SCF 的同名产品。

```bash
TENCENT_AGS_REGION=ap-guangzhou
TENCENT_AGS_ALL_IN_ONE_TOOL=delegate-aio-pi-v1
```

保留现有 API Key。新增配置优先于旧 `TENCENT_AGS_CODE_TOOL`；配置 All-in-One 后不会回退到旧 Code 工具。Compose 和 staging 环境生成器均透传新变量。本机 `.env` 已更新，Compute Broker 已重新创建并通过 `/ready` 检查。

## 网络策略：已实测并经用户确认

当前工具的网络模式为 PUBLIC。实测传入 E2B `allowInternetAccess=false` 后，仍能请求 `https://example.com` 并收到 HTTP 200。尝试腾讯的 `x-network-policy` 实例元数据覆盖时，服务返回 `UnsupportedOperation.SandboxInstance`：该 AIO 实例不支持 NetworkPolicy 下发。

2026-09-24 文档复核补充：上述结论限于当前 PUBLIC 工具和接入链路，不应推广为“腾讯云不支持禁网”。[官方网络模式文档](https://cloud.tencent.com/document/product/1814/132216)说明基础网络模式在 Tool 层配置，Instance 继承 Tool，运行中不能原地切换；[产品动态](https://cloud.tencent.cn/document/product/1814/123809)说明 NetworkPolicy 按灰度开放。当前报错只能确认这条实例策略路径不可用，无法据此确定是 AIO 类型限制还是账号/地域灰度差异。单独配置 SANDBOX/VPC 工具对本账号 AIO 的可用性尚未实测。

因此本实现只允许 All-in-One 的 `full` 网络任务；`no_network` 和 `allowlist` 在创建或连接前返回 `POLICY_UNSUPPORTED`，不会静默放开网络。

用户明确选择“允许相关任务联网，统一使用当前公网 All-in-One 工具”。本机迁移只修改路由允许的代表 `founder-representative-2`：

- 代表的实时 computeNetworkMode 和默认能力策略改为 FULL。
- 从现有发布版本克隆新版本，只修改 compute.networkMode 和对应 allowlist；不发布工作区其他草稿修改。
- 原版本和审计记录保留；新版本为 v11，ID `cmudi66so00019k1wjb8zqrxv`。
- 历史对话仍受其绑定版本约束；使用新对话验证新的联网策略。

相关官方说明：[网络模式](https://cloud.tencent.com/document/product/1814/132216)、[网络故障排查](https://cloud.tencent.com/document/product/1814/132217)、[All-in-One 操作](https://cloud.tencent.com/document/product/1814/130978)。实际兼容性以本账号、本地域实测为准。

## 代码路径与实现

调用链：模型任务编译器 → web-data compute client → Compute Broker 会话和策略 → 用户沙盒租约 → provider registry → 腾讯 E2B 适配器。

| 文件 | 本次处理 |
| --- | --- |
| `apps/compute-broker/src/config.ts` | 读取 All-in-One 工具名，兼容旧 Code 配置 |
| `apps/compute-broker/src/tencent-sandbox-config.ts` | 工具选择、网络模式检查、模板租约标识 |
| `apps/compute-broker/src/tencent-agsx-provider.ts` | All-in-One 支持 CODE / BROWSER；注入会话目录和浏览器运行环境；新建后初始化失败时清理实例 |
| `apps/compute-broker/src/sandbox-provider-registry.ts` | 使用新配置构建腾讯适配器 |
| `apps/compute-broker/src/sandbox-leases.ts` | 复用条件纳入腾讯地域、模板和原请求镜像 |
| `apps/compute-broker/src/leases.ts` | READY 会话同样检查模板与网络，阻止旧实例混用 |
| `apps/compute-broker/src/browser.ts` | 使用镜像内全局 Playwright 和系统 Chromium，无需临时下载依赖 |
| `apps/compute-broker/scripts/tencent-agsx-smoke.ts` | 验证代码、上传、联网、浏览器操作、暂停恢复及清理 |

真实工作目录仍为 `/home/user/workspace`，保留公共 `/workspace` 路径映射和上传后回读校验。当前镜像的 Node Playwright 位于 `npm root -g` 返回目录，Chromium 通过 `command -v chromium` 查找；云端已实测 `/usr/bin/chromium`。

为避免引入数据库结构变更，All-in-One 租约的 `baseImage` 保存运行环境标识：

```text
tencent://ap-guangzhou.tencentags.com/delegate-aio-pi-v1?image=debian%3Abookworm-slim
```

`ComputeSession.baseImage` 保留已发布的镜像契约。旧 Code 租约只有原镜像名称，不会匹配新的 All-in-One 租约。旧 READY 会话返回 `sandbox_template_changed_new_session_required`，不会静默转移文件系统。旧用户实例及数据未删除。

CODE 和 BROWSER 仍是不同租约复用维度；使用相同模板不表示共享同一个实例。OpenAI / Anthropic 浏览器动作复用新的 Playwright 启动路径；OpenCode computer-use 的 Daytona 限制保持现状，不属于本次接入范围。

## 验证

- Compute Broker 全套单元测试：264 通过、4 项数据库集成测试跳过。
- Compute Broker TypeScript 检查通过。
- 云端适配器 smoke：输入文件哈希校验、Python 执行、公网访问、浏览器截图、点击动作、暂停恢复后文件保留全部通过；测试实例已清理。
- 本机 Broker 配置确认工具为 `delegate-aio-pi-v1`，地域为 `ap-guangzhou`；`/ready` 正常。
- 真实 Broker 链路：创建 OWNER 测试会话、上传文件、发起工具请求、审批、后台执行通过。代码与浏览器执行均为 `SUCCEEDED` / exit 0，并生成 STDOUT、JSON 和 SCREENSHOT 产物；数据库租约确认目标模板及 FULL 网络。
- Broker 测试会话已 COMPLETED / RELEASED，测试沙盒已删除并将对应租约标记 ARCHIVED。迁移前后非 compute 的发布快照内容相同。

```bash
pnpm --filter @delegate/compute-broker test
pnpm --filter @delegate/compute-broker typecheck
pnpm --filter @delegate/compute-broker smoke:tencent-agsx
```

本机一次性策略迁移脚本和不含密钥的操作结果位于 `.local/tencent-aio/`，该目录不提交版本库。历史版本、旧 Code 工具配置及用户沙盒保留，便于核查或回退。回退时需要同时恢复代表实时网络策略、默认策略、活动发布版本和工具选择，不能仅改一个环境变量。
