# 统一登录与注册

分支：`codex/unified-account-onboarding`。基于已有手机号 / 微信接入分支继续开发；PR 目标分支为 `dev`。

## 行为与身份边界

- 手机验证码登录：原账号直接登录；只有服务端明确返回 `user.user_not_exist` 时，才切换 Register 并复用已验证的手机号。
- 账号登录：仅接受手机号或邮箱，不再支持用户名。邮箱登录与设置中的验证绑定采用腾讯云 SES；邮件配置未就绪时明确显示待启用。接入与当前验收范围见 `docs/email-login-ses.md`。
- 忘记密码：验证已绑定的中国大陆手机号后重置；SES 启用后也支持已绑定邮箱。未找到原账号不会自动注册。
- 微信首次授权：仅验证微信身份，先以 SignIn 尝试识别；未知身份显示“新用户 / 关联已有账号”，此时未创建 Logto 用户、Owner 或业务工作区。关联路径验证原账号密码或短信，再提交原微信验证记录，由 Logto 检查唯一性和 MFA。
- 新注册用户可设置密码、昵称，也可跳过。昵称上限沿用项目的 80 字符。密码最少 8 位且至少三类字符；服务器保留更严格的原策略、泄漏密码检查及限流。
- 用户名仅保留为历史资料，不再用于登录；昵称是 Owner 控制面显示名称；工作区名称和公开代表 Owner 署名仍独立，不联动覆盖。
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

6. 从 `http://localhost:3001/auth/login` 进入。所有格式有效的中国大陆 +86 手机号均可使用 `123456`；先点获取验证码。不发送真实短信。已有 SSO 会话可能直接进入工作台；测试新注册请用独立浏览器会话。

本地代理占用 127.0.0.1:3301，原 Logto core 直接端口改为 127.0.0.1:3303，admin 仍为 3302。代理保留原生 CSP 和 Cookie，不关闭安全头。固定码只映射到本机模拟收到的真实随机验证码；Logto 继续执行会话绑定、有效期、尝试次数和验证记录检查。账号中心的本地手机验证同样支持所有有效的 +86 手机号，不再使用号码白名单。邮箱仍发送真实邮件验证码；手机号 mock 不会代替邮箱验证。

## 切换真实短信与发布

此分支的正式 UI / 业务代码未部署到 `login.rag8.cn`；该域名仅已添加下文获批的本地微信回调 302 路由。正式 UI 使用无 mock 构建：

```sh
NODE_ENV=production AUTH_UI_OUTPUT_DIR=../../.local/logto/auth-ui-production pnpm --filter @delegate/auth-experience build
```

正式环境只能挂载这份 `build-mode.json` 为 `real` 的产物到固定版本 Logto 的 `/etc/logto/packages/experience/dist`，或采用经验证的自定义 UI 发布流程。OSS 本地挂载与 Logto Cloud 上传不同，不应把 OSS 的 Azure 上传接口当成已可用。

恢复腾讯云连接器时，先在本地 Logto 管理台用私有快照中的原配置替换 HTTP mock 连接器（既有手机号脚本会主动拒绝直接覆盖其他供应商），再用 `scripts/logto-phone-auth.mjs` 校验腾讯云配置，最后运行 `scripts/logto-unified-auth.mjs --apply`；无 mock 标志的配置工具拒绝 HTTP mock provider。不得把 `compose.auth-experience.local.yml`、mock 构建或 mock 服务部署到公网。统一 UI、Logto 策略、工作台开关和后台服务应一起发布并保留回滚快照。

官方接口说明：[Bring your UI](https://docs.logto.io/customization/bring-your-ui)、[社交登录](https://docs.logto.io/end-user-flows/sign-up-and-sign-in/social-sign-in)。当前实现另对照了固定版本 1.41 容器中的实际源码并完成本地 API 联调。

## 限制与待验收

- 新的微信“新建 / 关联”分支已做自动化调用顺序、冲突、错误密码及 state 防重放测试；未完成这版 UI 的真实微信扫码端到端验收。微信网站应用回调域为 `login.rag8.cn`，不能直接把 loopback 作为微信 redirect_uri；本地联调需要下述固定 302 回调转发。
- 历史上已创建 Logto 身份但尚无 Owner 的账号，按已有身份登录，不会回到“未知微信身份”选择分支。若微信已经属于另一 Logto 账号，不能直接用本流程转移或合并；本次未实现历史重复账号迁移，也未操作历史用户数据。
- 仅支持现有 TOTP 的登录二次验证；未实现新 MFA 注册、WebAuthn、CAPTCHA 或第三方应用授权同意页。不要把此自定义体验直接用于依赖这些页面的租户/应用；启用 CAPTCHA 的环境会明确阻止登录，不跳过验证。
- 邮箱登录、验证绑定和邮箱找回密码须先完成 SES 发信配置；当前本地香港 SES 已配置，真实测试请求已接受，收件及绑定验收待确认。仅有历史用户名的账号需先绑定可用身份再切换线上策略。
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
AUTH_INTEGRATION_PHONE=<尚未注册的 +86 测试号码> node --env-file=.env --env-file=.local/logto/delegate-auth.env --env-file=.local/logto/auth-mock.env scripts/tests/unified-auth.local.mjs
```

集成脚本拒绝修改已有测试号码账号，只清理本次新建的 Logto fixture，不创建业务工作区。重新运行时选尚未使用的 +86 测试号码。

## 本地微信回调修复（2026-09-21）

根因：登录页直接用 `location.origin` 构造微信 `redirect_uri`，本机发出了 `http://127.0.0.1:3301/callback/...`，与微信网站应用批准的 `login.rag8.cn` 不匹配。只替换成线上 Logto 的 `/callback/...` 也不正确，因为微信验证记录、Cookie 和浏览器 state 留在本地实例。

修复后的本地链路：本地 Logto 发起授权 → 微信 → `https://login.rag8.cn/_delegate/local-wechat/psrzl0j00w79` → 浏览器收到固定 HTTP 302 → `http://127.0.0.1:3301/callback/psrzl0j00w79`。浏览器回到本机原会话后继续执行原有 state、有效期、connector 和 Logto 验证；公网 Logto 不交换这次授权码，也不创建/合并本地身份。

**当前状态：用户明确批准后，固定 302 路由已添加，本地页面已启用。** 首次自动审批拒绝后没有绕过；本次依据用户后续明确授权执行。全部既有 service labels 保留，线上 Logto 运行 task ID 未改变。浏览器安全策略不允许代理操作微信授权页，真实扫码仍需用户完成。

今后重新构建本机体验时，使用以下显式配置以保留已获批的本地微信入口：

```sh
NODE_ENV=development \
DELEGATE_AUTH_UI_MOCK_SMS_ORIGIN=http://127.0.0.1:3301 \
WECHAT_WEB_CALLBACK_DOMAIN=login.rag8.cn \
DELEGATE_AUTH_WECHAT_LOCAL_CALLBACK_URI=https://login.rag8.cn/_delegate/local-wechat/psrzl0j00w79 \
pnpm --filter @delegate/auth-experience build
```

构建产物 `local-wechat-relay-labels.json` 给出可审核的 Traefik service labels。只允许给 `delegate_logto` 添加其中的 `delegate-local-wechat` 路由/中间件标签，保留全部原有标签，不更新 task template、镜像或凭据。应用前保存标签快照；应用后检查精确路径返回 302、Location 保留 query 且目标固定、其他 connector/public callback 不匹配该路由、现有健康检查和运行 task ID 不变。下一次完整 stack 部署可能移除临时 service labels，需显式重新审核该本地联调入口。

转发只匹配已批准域名、固定 connector 路径和 GET；不能传入任意 return URL。响应使用 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`。它是浏览器跳转，不是服务器反向代理至服务器自身的 loopback。生产构建禁止包含本地 relay；未配置/域名不符/connector不符会在外跳前失败，正常公网回调仍使用自身 `/callback/<id>`。

修改范围仅 5 个文件：`build.mjs`（显式本地配置、域名检查、生成固定路由标签）、`src/flow.ts`（回调地址选择与拒绝错误配置）、`src/main.tsx`（使用正确回调并核对连接器返回的 redirect_uri/state）、`src/flow.test.ts`（新增 11 项回归）、本运行手册。

已运行 `pnpm --filter @delegate/auth-experience test`（30 项通过）、对应 `typecheck` 和本地构建（通过）。真实微信扫码未运行，不能据此宣称完整微信登录已恢复。


本次部署后验证（均使用虚构 code/state，不跟随跳转、不请求微信授权页）：

| 测试场景 | 输入／前置条件 | 预期结果 | 实际结果 |
| --- | --- | --- | --- |
| 已批准的固定回调 | GET 固定 relay 路径，虚构 code/state | 302 到本机对应 connector，保留查询参数 | 通过 |
| 转发响应头 | 同上 | no-store、no-referrer | 通过 |
| 原公网回调 | 原公网 connector 的 /callback 路径 | 不转发本地 | HTTP 200，未转发 |
| 其他 connector | /_delegate/local-wechat/other-connector | 不匹配固定转发 | HTTP 200，未转发 |
| 非 GET 请求 | POST 固定路径 | 不匹配固定转发 | HTTP 404，未转发 |
| 线上 OIDC 健康 | /.well-known/openid-configuration | 200 | 通过 |
| 本地授权参数 | 原生 Experience API 创建微信授权验证记录 | redirect_uri 为批准域名，state 不变，scope=snsapi_login | 通过，未访问微信授权页 |
| 本地前端产物 | GET /build-mode.json | localWechatCallback 为已批准的固定路径 | 通过 |

部署前标签快照和部署核对结果保存于被 Git 忽略的 `.local/logto/wechat-local-relay-before-*.json`、`.local/logto/wechat-local-relay-applied.json`。当前登录体验单测重新运行，30 项通过；部署时另补充了下述资源缓存修复，并通过对应构建回归、typecheck 和实际 HTTP 资源校验。

本次部署还确认 Logto 静态资源缓存为 7 天；构建器现为 JS/CSS URL 添加内容摘要版本，回调配置变更后普通刷新即可加载新文件，避免旧脚本继续发送 loopback 回调。对应构建回归测试校验了配置变化会生成不同脚本 URL。


扫码后若微信验证接口成功，但账号识别返回 `404/user.identity_not_exist`，应进入新建/关联选择；不要与手机号专用的 `user.user_not_exist` 混用。该差异已由真实扫码审计日志和 Logto 1.41 源码确认，并加入回归测试。2026-09-21 的本地修复构建已启用，用户需重新发起扫码，不能复用已消费的授权码。


微信绑定成功后如果工作台登录状态已过期，重新从 Dashboard 的 `/auth/login` 发起登录即可，不要重放旧回调 code，也不必重复绑定。state 有效期仍为 10 分钟；无效回调现在进入可恢复的提示页。2026-09-21 已通过用户真实扫码绑定结果、本地只读绑定状态和浏览器新登录确认“关联已有账号 → 进入原账号工作台”，首次微信新建账号分支仍需单独验收。


## 原生账号中心“添加微信”回调（2026-09-21）

登录体验与 Account Center 是两套客户端：后者通过 `POST /api/verifications/social` 发起授权，使用 `/account/callback/social/<connectorId>` 回调。之前的登录入口修复没有覆盖它，因此仍向微信提交 loopback redirect_uri。

当前本地修复复用**已获批的同一条公网固定 302**，没有添加或修改线上路由：本地代理只对已配置微信 connector 的原生账号中心请求，把回调改为批准的 relay URL 并增加 `delegate_flow=account`；在验证请求中保持相同回调。返回本地 `/callback/<id>` 后，代理识别这个标记，将 code/state/error 转发到固定的 `/account/callback/social/<id>` 并移除标记。未标记的普通登录回调仍进入原登录体验。

本机 `.local/logto/auth-mock.env` 还需要以下两个非密钥配置（已配置）：

```dotenv
WECHAT_WEB_CALLBACK_DOMAIN=login.rag8.cn
DELEGATE_AUTH_WECHAT_LOCAL_CALLBACK_URI=https://login.rag8.cn/_delegate/local-wechat/psrzl0j00w79
```

配置改变后按原 local overlay 重建 `auth-mock-sms` 服务。修复不修改原生账号中心的静态文件，也不需要清理账户 Cookie；关闭旧微信错误页，回到账号安全页重新点击“添加”即可发起新请求。

安全边界：标记仅选择固定的本地页面，不能指定目标 URL，也不是身份凭据。Authorization、二次验证头、state、验证记录 ID 都保留，原生 Logto 仍执行验证及最终绑定/冲突检查；未认证请求实际返回 401。非本机 Origin 被拒绝，其他 provider 和账号 mutation 请求不改写。此逻辑只在显式开启的本地开发代理运行，生产登录不使用它。

| 测试场景 | 输入／前置条件 | 预期结果 | 实际结果 |
| --- | --- | --- | --- |
| 原生添加微信 | 配置中的 connector、原生 account 回调 | 授权参数使用批准域名，保留 state/验证信息 | 单测、HTTP 代理、固定版本真实连接器纯 URI 生成验证通过 |
| 原生验证回调 | 原 verificationRecordId/code/state | 保留证明，只保持同一 relay redirectUri | 自动化通过 |
| 公网返回本机 | 合成 code/state + account 标记 | 先经过既有 302，再回到固定原生 Account Center 回调 | 实际 HTTP 转发通过，未访问微信授权页 |
| 普通登录 | 无 account 标记 | 继续原登录回调 | 实际 HTTP 验证通过 |
| 鉴权与边界 | 无 token、错误 Origin、错误 callback、其他 provider | 保留 401、拒绝非法请求，不扩大改写范围 | 自动化及真实 Logto 401 验证通过 |

本次修改 5 个文件：`scripts/auth-mock-sms.mjs`（本地回调配置、精准请求改写与分流）、`scripts/tests/auth-mock-sms.test.ts`（配置/路由边界）、`scripts/tests/account-wechat-proxy.test.ts`（实际 HTTP 代理鉴权和证明保留）、`package.json`（纳入既有 CI 调用的统一登录测试入口）、本运行手册。

`pnpm test:logto:unified`：21 项通过。`pnpm exec turbo run test --concurrency=1`：28/28 任务成功，全部复用缓存；本次改动位于根 scripts，已另跑上述定向测试。真人从账号安全页再次扫码绑定尚需用户验收，不把合成转发测试描述为已实际完成绑定。

## 2026-09-22 本地 +86 全号码验证

已按用户要求移除本地 mock 号码白名单。验证代码始终为 `123456`，须先通过正常入口获取验证码；号码格式、Logto 会话、有效期、密码、身份绑定与冲突校验继续正常运行。

- `pnpm test:logto:unified`：60 项通过，包含原名单外号码的六种验证码用途、原生账号中心代理、非法格式和环境隔离。
- `AUTH_INTEGRATION_PHONE=8619900922001 node --env-file=.env --env-file=.local/logto/delegate-auth.env --env-file=.local/logto/auth-mock.env scripts/tests/unified-auth.local.mjs`：本地 Logto 注册、昵称/密码保存、验证码再次登录、密码登录与重置通过；旧密码和跨会话验证记录被拒绝。仅本次新建测试账号已清理，未创建业务工作区。
- 本次未重新运行整个工作区测试；未发送真实短信，未改线上服务。

## 三方账号管理

账户信息中的登录方式顺序为手机号、邮箱、登录密码、三方账号绑定。三方账号按已启用服务商显示名称、绑定状态和直接操作：未绑定显示“绑定账号”，已绑定显示“更换绑定 / 解除绑定”。不再使用中间管理页，旧 `settingsSection=connections` 链接回到“资料与偏好”。

列表读取 Logto 已启用且在 Account Center 可见的社交连接器，按 target 去重并优先选择 Web 连接器。当前显示微信，未来新增服务商自动沿用此列表；Native-only、关闭或只读的服务商不提供越权操作入口。绑定、更换及解除绑定分别进入原生 `/account/social/:connectorId`、`/change` 和 `/remove`，继续使用 Logto 的身份验证、OAuth state、验证记录和冲突校验。工作台不直接修改用户 identities，也不返回第三方令牌。

返回账户资料页或切回浏览器窗口时刷新绑定状态。新增覆盖：多个服务商状态、Web 优先去重、只读/关闭控制、异常配置/网络失败、原生操作路由及敏感字段不外泄。

账户信息中的手机号、邮箱、密码和三方绑定操作在当前标签页打开，以便原生安全验证页的“返回”按钮通过浏览器历史回到账户信息。链接同时携带 Logto 原生 `redirect` 参数，完成操作后返回固定的资料页及其标题锚点；返回地址由当前工作台 origin 构造，不使用调用方传入的任意跳转目标。已打开的旧验证标签页需要先返回工作台，再从新入口进入。
