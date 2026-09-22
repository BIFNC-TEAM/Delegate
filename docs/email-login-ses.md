# 手机号 / 邮箱登录与腾讯云 SES（2026-09-22）

分支：`codex/unified-account-onboarding`，不创建 PR。邮件方案已按用户最新选择采用腾讯云 SES API，未使用或配置 SMTP。

## 当前行为

- 账号登录只接受手机号或邮箱。普通用户名在前端直接拒绝，Logto 登录策略也不再启用 username；保留原 username 数据，不改昵称、Owner、工作区及已有绑定。
- 短信登录/注册保持原流程。邮箱绑定需要先验证当前账号，再验证新邮箱，使用原生 `/account/email`；不通过 Management API 直接把未验证邮箱写为已绑定。
- 设置页始终显示邮箱状态。后台从 Logto 当前公开能力配置确认邮箱登录及绑定均启用后，才提供绑定/更换入口；未启用时明确显示“邮箱验证服务暂未启用”。
- 邮件能力启用后，账号密码登录支持已绑定邮箱，找回密码也支持已绑定邮箱验证码。
- Logto 1.41 的免密码注册模式要求非 username 登录方式同时启用验证码，所以没有邮件连接器时不能安全地仅打开 email/password。当前本地已关闭用户名登录，暂保持手机号登录；邮件配置补齐后统一开启 email 方法及 Account Center email Edit。

## SES 配置

私有文件：`.local/logto/tencent-ses.env`，权限 600，已加入 Git 忽略范围。模板：`deploy/logto/tencent-ses.env.example`。

必填：

```dotenv
TENCENT_SES_SECRET_ID=
TENCENT_SES_SECRET_KEY=
TENCENT_SES_REGION=ap-guangzhou
TENCENT_SES_FROM_EMAIL=
TENCENT_SES_TEMPLATE_ID=
TENCENT_SES_CODE_VARIABLE=code
TENCENT_SES_SUBJECT=Delegate 邮箱验证码
```

要求发信域名已验证、发信地址可用、验证码模板审核通过且包含 `{{code}}`；模板变量名不同时用 CODE_VARIABLE 指定。地址、模板、地域必须匹配。密钥应具备 SES SendEmail 权限。密钥不得写进前端、日志或 Git。

依据：[腾讯云 SendEmail API](https://cloud.tencent.com.cn/document/api/1288/51034)、[发信配置](https://cloud.tencent.com/document/product/1288/47454)。当前仅使用模板发送，不依赖 Simple 自定义正文或 SMTP。

本地安装连接器（已完成）：

```sh
docker compose --env-file .local/logto/logto.env -f compose.logto.yml -f compose.auth-experience.local.yml --profile auth-mock up -d --no-deps logto
```

填写配置后，先预览再应用（不会发送邮件）：

```sh
LOGTO_BACKCHANNEL_ENDPOINT=http://127.0.0.1:3301 node --env-file=.env --env-file=.local/logto/delegate-auth.env --env-file=.local/logto/tencent-ses.env scripts/logto-ses-auth.mjs
LOGTO_BACKCHANNEL_ENDPOINT=http://127.0.0.1:3301 node --env-file=.env --env-file=.local/logto/delegate-auth.env --env-file=.local/logto/tencent-ses.env scripts/logto-ses-auth.mjs --apply
LOGTO_BACKCHANNEL_ENDPOINT=http://127.0.0.1:3301 node --env-file=.env --env-file=.local/logto/delegate-auth.env --env-file=.local/logto/auth-mock.env scripts/logto-unified-auth.mjs --mock-sms --apply
```

SES 配置工具会备份原连接器到私有文件并回读校验；发现其他邮件供应商时拒绝静默覆盖。真实环境不要使用 `--mock-sms`，且需单独部署本分支的连接器和应用代码。本次未修改线上登录策略或发送真实邮件。

## 实现与验证

连接器复用固定 Logto 运行时，使用 Node 原生 crypto 实现 TC3-HMAC-SHA256，无新增 SDK。只允许单一收件人的 OTP 场景；保留 Logto 的有效期、限流、尝试次数、验证记录和绑定冲突校验。网络/超时、SES API 错误、畸形响应均报错；不会自动重发不确定的请求。只返回安全的错误码和 RequestId，不回显收件人、验证码或密钥。API 接受请求不代表邮件已进入收件箱。

| 测试场景 | 输入／前置条件 | 预期结果 | 实际结果 |
| --- | --- | --- | --- |
| 登录标识限制 | 手机号、邮箱、普通用户名 | 接受前两者，拒绝用户名 | 自动化通过 |
| 后端用户名限制 | 临时账号的正确用户名及密码 | 不签发登录，识别阶段拒绝 | 本地原生 Logto 返回 422/user.sign_in_method_not_enabled，通过；临时账号已删除 |
| 邮箱密码重置 | 已验证邮箱 proof | 进入重置密码，不创建新账号 | 自动化通过 |
| 邮箱入口能力 | 邮件未启用/已启用及 Edit 控制 | 真实反映入口可用性 | 自动化通过 |
| SES 签名 | 固定合成凭据、时间及负载 | 与独立 Python 参考签名一致 | 通过 |
| SES 发送参数 | BindNewIdentifier、6 位 code | 指定模板、单收件人、正确模板变量 | 单测和固定版本连接器运行测试通过 |
| SES 失败/超时 | 失败码、损坏响应、网络异常 | 不误报成功、不暴露敏感内容、不自动重复发送 | 自动化通过 |
| 固定版本兼容 | Logto 1.41、无网络容器 | 模块/metadata/configGuard/SIE/Account Center schema 均有效 | 3 项运行测试通过 |
| 真实邮件投递与绑定 | 实际 SES 密钥、发信地址和审核模板 | 收到邮件后完成原生邮箱验证 | 尚未执行，等待私有配置补齐 |

已运行：登录流程 37 项通过；`pnpm test:logto:unified` 34 项通过；资料/管理客户端 30 项通过；固定版本无网络运行测试 3 项通过；类型检查和 Dashboard 构建通过；工作区回归 28/28 任务成功（包含缓存复用和既有条件跳过的测试）。首次 HTTP 测试被沙箱拒绝监听本机端口，允许本地监听后完整重跑通过。

核心修改：登录体验的输入校验/文案/邮箱找回密码，统一 Logto 登录策略，工作台邮箱状态与绑定入口，后台邮件能力查询，新增 SES 连接器及私有配置模板/配置工具，相关单测与固定版本运行测试，CI 检查及本说明。业务账号数据未迁移或自动合并。

注意：生产切换前需让只有 username 的历史账号先绑定手机号/邮箱或其他可用身份。关闭登录方式不会删除 username，但不能再用它发起登录。
