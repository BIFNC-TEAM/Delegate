# 统一登录与注册

分支：`codex/unified-account-onboarding`。基于已有手机号 / 微信接入分支继续开发；不创建 PR。

## 行为与身份边界

- 手机验证码登录：原账号直接登录；只有服务端明确返回 `user.user_not_exist` 时，才切换 Register 并复用已验证的手机号。
- 账号登录：支持手机号与旧用户名。配置了邮件连接器时支持邮箱。Logto 1.41 要求免密码注册时所有非 username 登录方式同时启用验证码；缺少邮件连接器时配置工具拒绝移除已有邮箱登录，避免锁住老用户。
- 忘记密码：验证已绑定的中国大陆手机号后重置；未找到原账号不会自动注册。
- 微信首次授权：仅验证微信身份，先以 SignIn 尝试识别；未知身份显示“新用户 / 关联已有账号”，此时未创建 Logto 用户、Owner 或业务工作区。关联路径验证原账号密码或短信，再提交原微信验证记录，由 Logto 检查唯一性和 MFA。
- 新注册用户可设置密码、昵称，也可跳过。昵称上限沿用项目的 80 字符。密码最少 8 位且至少三类字符；服务器保留更严格的原策略、泄漏密码检查及限流。
- 用户名是旧账号登录标识；昵称是 Owner 控制面显示名称；工作区名称和公开代表 Owner 署名仍独立，不联动覆盖。
- 个人信息显示手机、密码设置状态、微信绑定状态，支持 HTTPS 头像地址；敏感绑定及密码操作通过原生 Account Center 二次验证。昵称继续走现有 Owner 设置的版本校验和审计；原生账号中心的 name 保持只读，避免提供第二个不同步的昵称编辑入口。
- Dashboard 只持有受限服务令牌，Logto M2M 密钥仍只在 workflow-runner。后台再次校验 Owner、issuer、subject 的精确绑定。接口不提供任意用户查询、改密码、转移微信或账号合并能力。
- Owner 注册意图通过 `DELEGATE_UNIFIED_AUTH_ENABLED=true` 写入已签名的 Owner OIDC state；Audience 应用的注册边界保持原有行为。

## 本地运行

需要现有本地 Logto、Dashboard OIDC 配置以及 Node >=22.12。已验证 Node 24.19、Logto 1.41、Docker Compose 2.31。

1. `pnpm logto:local:backup`。保留管理 API 的 sign-in-exp、account-center、connectors、custom-profile-fields 私有快照。
2. `.local/logto/auth-mock.env`（权限 600）配置以下字段；令牌用密码学随机值，切勿提交：

```dotenv
NODE_ENV=development
DELEGATE_AUTH_MOCK_SMS=true
LOGTO_ENDPOINT=http://127.0.0.1:3301
AUTH_MOCK_SMS_TOKEN=<至少32字符的随机令牌>
AUTH_MOCK_SMS_ALLOWED_PHONES=8613800138000,8613800138001
```

3. 构建本地体验并启动：

```sh
NODE_ENV=development DELEGATE_AUTH_UI_MOCK_SMS_ORIGIN=http://127.0.0.1:3301 pnpm --filter @delegate/auth-experience build
docker compose --env-file .local/logto/logto.env -f compose.logto.yml -f compose.auth-experience.local.yml --profile auth-mock up -d logto auth-mock-sms
LOGTO_BACKCHANNEL_ENDPOINT=http://127.0.0.1:3301 node --env-file=.env --env-file=.local/logto/delegate-auth.env --env-file=.local/logto/auth-mock.env scripts/logto-unified-auth.mjs --mock-sms --apply
```

4. 本地 `.env` 设置 `DELEGATE_UNIFIED_AUTH_ENABLED=true`，以及至少 32 字符随机 `OWNER_PROFILE_INTERNAL_TOKEN`。Dashboard 与 workflow-runner 使用同一服务令牌。后台使用现有 Logto 管理配置。
5. 按原本的完整运行时配置重建 Dashboard 和 workflow-runner（包含原支付回调等配置，不能只用不完整的 `.env`）。本机原回调已另存 `.local/logto/account-profile-runtime.env`：

```sh
docker compose --env-file .env --env-file .local/logto/delegate-auth.env --env-file .local/logto/account-profile-runtime.env -f compose.yml -f compose.local.yml up -d --no-deps dashboard workflow-runner
```

6. 从 `http://localhost:3001/auth/login` 进入。白名单中的测试号码使用 `123456`；先点获取验证码。不发送真实短信。已有 SSO 会话可能直接进入工作台；测试新注册请用独立浏览器会话。

本地代理占用 127.0.0.1:3301，原 Logto core 直接端口改为 127.0.0.1:3303，admin 仍为 3302。代理保留原生 CSP 和 Cookie，不关闭安全头。固定码只映射到本机模拟收到的真实随机验证码；Logto 继续执行会话绑定、有效期、尝试次数和验证记录检查。账号中心的本地手机验证也仅对白名单提供映射。

## 切换真实短信与发布

此分支未部署到 `login.rag8.cn`。正式 UI 使用无 mock 构建：

```sh
NODE_ENV=production AUTH_UI_OUTPUT_DIR=../../.local/logto/auth-ui-production pnpm --filter @delegate/auth-experience build
```

正式环境只能挂载这份 `build-mode.json` 为 `real` 的产物到固定版本 Logto 的 `/etc/logto/packages/experience/dist`，或采用经验证的自定义 UI 发布流程。OSS 本地挂载与 Logto Cloud 上传不同，不应把 OSS 的 Azure 上传接口当成已可用。

恢复腾讯云连接器时，先在本地 Logto 管理台用私有快照中的原配置替换 HTTP mock 连接器（既有手机号脚本会主动拒绝直接覆盖其他供应商），再用 `scripts/logto-phone-auth.mjs` 校验腾讯云配置，最后运行 `scripts/logto-unified-auth.mjs --apply`；无 mock 标志的配置工具拒绝 HTTP mock provider。不得把 `compose.auth-experience.local.yml`、mock 构建、白名单或 mock 服务部署到公网。统一 UI、Logto 策略、工作台开关和后台服务应一起发布并保留回滚快照。

官方接口说明：[Bring your UI](https://docs.logto.io/customization/bring-your-ui)、[社交登录](https://docs.logto.io/end-user-flows/sign-up-and-sign-in/social-sign-in)。当前实现另对照了固定版本 1.41 容器中的实际源码并完成本地 API 联调。

## 限制与待验收

- 新的微信“新建 / 关联”分支已做自动化调用顺序、冲突、错误密码及 state 防重放测试；未完成这版 UI 的真实微信扫码端到端验收。微信网站应用回调域为 `login.rag8.cn`，本地 loopback 不能替代正式回调域。
- 历史上已创建 Logto 身份但尚无 Owner 的账号，按已有身份登录，不会回到“未知微信身份”选择分支。若微信已经属于另一 Logto 账号，不能直接用本流程转移或合并；本次未实现历史重复账号迁移，也未操作历史用户数据。
- 仅支持现有 TOTP 的登录二次验证；未实现新 MFA 注册、WebAuthn、CAPTCHA 或第三方应用授权同意页。不要把此自定义体验直接用于依赖这些页面的租户/应用；启用 CAPTCHA 的环境会明确阻止登录，不跳过验证。
- 忘记密码目前使用手机号；未绑定手机号的旧账号需先用现有登录方式进入并绑定。邮箱找回需要邮件服务和单独配置。
- 头像目前为 HTTPS 图片地址，未增加文件上传；不保证第三方图片地址永远可访问。
- 测试保留了本地合成演示账号，未修改生产用户、生产 Logto 或腾讯云模板。

## 验证命令

```sh
pnpm --filter @delegate/auth-experience test
pnpm test:logto:unified
pnpm exec turbo run test --concurrency=1
pnpm --filter @delegate/auth-experience typecheck
pnpm --filter @delegate/dashboard typecheck
pnpm --filter @delegate/workflow-runner typecheck
pnpm --filter @delegate/dashboard build
AUTH_INTEGRATION_PHONE=<尚未注册的白名单测试号码> node --env-file=.env --env-file=.local/logto/delegate-auth.env --env-file=.local/logto/auth-mock.env scripts/tests/unified-auth.local.mjs
```

集成脚本拒绝修改已有测试号码账号，只清理本次新建的 Logto fixture，不创建业务工作区。重新运行时选尚未使用的白名单号码。
