# 统一登录验收记录（2026-09-21）

状态：本地实现与验证完成；真实微信扫码和线上部署尚未完成。
分支：`codex/unified-account-onboarding`，未创建 PR。原有 `reports/agent-timing/` 未修改或纳入提交。未修改线上用户或公网 Logto。

现有实现缺少验证码登录/注册合一、微信未知身份分流、可跳过的资料设置，以及工作台内完整的绑定状态展示。此次在固定版本 Logto Experience API 上实现流程，保留 OIDC、Owner admission 和已签名注册意图。Logto 管理密钥继续仅由后台服务持有。昵称不会联动覆盖工作区或公开 Owner 署名。

## 自动化与浏览器验收

| 测试场景 | 输入／前置条件 | 预期结果 | 实际结果 |
| --- | --- | --- | --- |
| 首次手机号注册 | 未注册的本地白名单号码、先获取验证码、输入 123456 | 验证后注册，出现可跳过的密码/昵称页面 | 单测、真实 Logto API、浏览器通过 |
| 已有手机号登录 | 已注册白名单号码、123456 | 进入原账号工作台，显示原昵称 | API、浏览器通过 |
| 注册资料持久化 | 有效密码、昵称“本地登录测试” | 登录后正确显示昵称，密码可用于登录 | API和浏览器通过 |
| 跳过资料 | 注册后点击暂时跳过 | 进入工作台；设置页密码显示未设置 | 浏览器通过 |
| 密码登录与重置 | 正确/错误密码、绑定手机验证后重置 | 错误密码拒绝；旧密码失效、新密码可登录 | 真实 Logto API通过 |
| 验证会话隔离 | 将上一次会话 verificationId 用到新会话 | 拒绝识别用户 | 真实 Logto API通过 |
| 微信首次分流 | 模拟实际错误码 user.identity_not_exist（404） | 创建任何用户/工作区前显示二选一 | 自动化通过；真实扫码未执行 |
| 关联旧账号 | 有效微信证明 + 验证原账号 | 只绑定原账号，不进入 Register | 自动化通过；真实扫码未执行 |
| 关联冲突或验证失败 | 微信已被占用、原密码错误、原账号不存在 | 不覆盖身份、不创建新账号、不回跳成功 | 自动化通过 |
| 微信回调保护 | state 不匹配、过期、错误 connector、取消授权 | 拒绝回调，允许重新开始 | 自动化通过 |
| 手机变化/重复发送 | 获取码后改手机号；倒计时内重发 | 拒绝旧 challenge；限制重发 | 自动化通过 |
| mock 隔离 | 公网 issuer、生产 NODE_ENV、未启用开关、无白名单 | 拒绝运行 mock；只映射白名单测试码 | 自动化通过 |
| 账号资料权限 | 未登录、Owner/issuer/subject不匹配、跨域写入、错误内部令牌 | 拒绝请求，管理凭据不进入 Dashboard | 自动化通过；容器配置核对通过 |
| 上游异常 | 网络失败、资料字段缺失、用户停用、头像保存回读不符 | 明确失败，不显示虚假成功或空成功资料 | 自动化通过 |
| 个人设置 | 登录后打开设置 | 展示真实手机、密码/微信状态与管理入口 | 浏览器通过 |
| 头像 | 不安全 URL、超过长度、有效 HTTPS URL、清除后回读异常 | 验证输入，仅写当前用户 avatar，核对保存结果 | 自动化通过；真实上传未提供（支持 URL） |

## 实际命令和结果

- `pnpm --filter @delegate/auth-experience test`：19 项通过。
- `pnpm test:logto:unified`：11 项通过。
- `pnpm exec turbo run test --concurrency=1`：28/28 个任务成功（18 个缓存复用），3075 项通过，195 项由既有条件跳过。191 项 PostgreSQL 集成用例需要显式 `DELEGATE_POSTGRES_E2E=1` 和专用数据库，另 4 项模型评估需对应评估开关；本次未开启，不算通过。
- `pnpm typecheck`：21/21 个任务成功（13 个缓存复用）。另分别运行了登录体验、Dashboard、workflow-runner 的 typecheck，通过。
- `pnpm --filter @delegate/dashboard build`：通过。
- `NODE_ENV=production AUTH_UI_OUTPUT_DIR=../../.local/logto/auth-ui-production pnpm --filter @delegate/auth-experience build`：通过，产物为 real 模式；本地运行中的 mock 构建不受影响。
- `AUTH_INTEGRATION_PHONE=… node --env-file=.env --env-file=.local/logto/delegate-auth.env --env-file=.local/logto/auth-mock.env scripts/tests/unified-auth.local.mjs`：最终通过注册/资料持久化、密码登录、重置与旧密码失效、错误验证、会话隔离；本次临时身份已清理。
- `git diff --check`：通过。

此前出现的失败也保留记录：系统 Node 22.11 缺少兼容的原生测试依赖，换用现有 Node 24.19 后解决；默认并行测试被沙箱禁止监听本地端口，采用允许本地监听的 CI 串行命令后通过；原生密码联调一次连接中断返回 500，未当作成功，复测通过。已有架构测试发现 Dashboard 不应持有 M2M 密钥，已修正为后台受限接口，未删除或放宽该测试。

## 文件清单与原因

| 文件 | 修改内容 |
| --- | --- |
| `apps/auth-experience/package.json` | 复用 React、esbuild、TypeScript、Vitest 创建登录体验工作区 |
| `apps/auth-experience/tsconfig.json` | 沿用根 TS 配置并启用 JSX |
| `apps/auth-experience/index.html` | Logto SPA 入口，外部脚本/样式兼容 CSP |
| `apps/auth-experience/build.mjs` | real/mock 隔离构建、输出目录及模式标记 |
| `apps/auth-experience/src/flow.ts` | 验证码注册登录、密码重置、微信分流/关联、可选资料及回调验证 |
| `apps/auth-experience/src/main.tsx` | 登录页、验证码倒计时、错误恢复、微信选择与资料补充 UI |
| `apps/auth-experience/src/styles.css` | 遵循 DESIGN.md 的字体、青绿/靛蓝、间距和响应式样式 |
| `apps/auth-experience/src/flow.test.ts` | 19 项流程与回调边界测试 |
| `apps/web/app/auth/login/route.ts` | 开关控制统一入口，并签名记录 Owner 注册意图 |
| `apps/web/app/api/dashboard/account-profile/route.ts` | 当前会话资料 API，Origin 校验及 private/no-store |
| `apps/web/app/api/dashboard/account-profile/client.ts` | Dashboard 到后台的受限资料请求，不携带 M2M 密钥 |
| `apps/web/app/dashboard/dashboard-account-profile.tsx` | 头像地址和绑定状态 UI、保存/重试、保留未保存的输入 |
| `apps/web/app/dashboard/dashboard-settings.tsx` | 个人资料页挂接新组件，显示名称标签改为昵称 |
| `apps/web/app/dashboard/dashboard-v2.css` | 账号资料组件的现有设计系统样式 |
| `apps/web/tests/account-profile-route.test.ts` | 私有资料 API 认证、跨域及异常边界 |
| `apps/web/tests/creator-auth-admission-routes.test.ts` | 验证统一登录仍使用已签名 Owner 注册意图 |
| `apps/workflow-runner/src/index.ts` | 注册受限内部资料端点 |
| `apps/workflow-runner/src/owner-profile.ts` | 服务令牌验证、请求范围限制、Owner身份再次校验 |
| `apps/workflow-runner/tests/owner-profile.test.ts` | 验证内部端点拒绝无凭据、超范围和超大请求 |
| `packages/web-data/src/logto-management.ts` | 增加指定用户资料读取和仅头像更新，校验上游响应 |
| `packages/web-data/src/owner-identity-profile.ts` | 精确 Owner/issuer/subject 校验、安全 DTO 和头像回读 |
| `packages/web-data/package.json` | 导出账号资料模块 |
| `packages/web-data/tests/owner-identity-profile.test.ts` | 身份权限、DTO脱敏、头像与上游异常测试 |
| `packages/web-data/tests/logto-management.test.ts` | 增加仅头像写入和畸形响应拒绝测试 |
| `scripts/auth-mock-sms.mjs` | 仅本地白名单 mock 收件箱、同源代理、原生账号中心测试码映射 |
| `scripts/logto-unified-auth.mjs` | 配置统一登录策略、可选资料、原生账号中心并回读验证 |
| `scripts/tests/auth-mock-sms.test.ts` | mock 环境、凭据、用途、白名单和过期边界 |
| `scripts/tests/logto-unified-auth.test.ts` | 策略兼容、保留更严格设置及禁止公网 mock |
| `scripts/tests/unified-auth.local.mjs` | 本地原生 Logto 集成测试及专属 fixture 清理 |
| `compose.auth-experience.local.yml` | 本地自定义体验挂载与 loopback mock 代理 |
| `compose.yml` | 统一登录开关与仅 Dashboard/后台共享的受限服务令牌 |
| `compose.local.yml` | 后台热更新挂载模块导出清单 |
| `.env.example` | 新开关和内部资料接口配置说明 |
| `package.json` | 新增配置/测试脚本入口 |
| `pnpm-lock.yaml` | 仅新增登录体验工作区 importer，无依赖升级 |
| `.github/workflows/verify.yml` | CI 增加统一登录配置与 mock 隔离测试 |
| `docs/unified-auth-runbook.md` | 本地运行、真实短信切换、身份语义和限制 |
| `docs/unified-auth-validation.md` | 本次验收、失败/跳过记录及逐文件清单 |

## 下一步

先用本地白名单账号验收页面；再对真实短信投递和 `login.rag8.cn` 下的微信首次注册/关联进行上线前验收。历史上已被另一个 Logto 身份占用的微信不自动转移，历史孤立账号也不自动合并。完整限制见运行手册。


## 真实扫码反馈后的修正

用户真实扫码的本地日志显示：2026-09-21 08:40:22 和 08:41:06 UTC，微信 verification/social/.../verify 返回 200，随后 identification 返回 404；只读审计查询确认 `error.code=user.identity_not_exist`。这是当前本地身份库中尚未绑定的微信，不是微信授权失败。

首次实现错误地把手机号识别的 `user.user_not_exist` 用在微信分支和模拟测试中。纠正模拟值后，旧代码可稳定复现 4 项失败、26 项通过。修复仅在微信识别返回 `user.identity_not_exist` 且 HTTP 404 时进入选择页，手机号、密码和其他错误保持原处理。选择前不创建账号/工作区；选择关联后仍必须验证原账号。

修改文件：`apps/auth-experience/src/flow.ts`（精确识别社交身份不存在）；`apps/auth-experience/src/flow.test.ts`（纠正原用例并补充显式新建、已绑定直接登录、非目标错误测试）；两个统一登录文档同步实际证据及验收状态。未修改线上回调或历史账号资料。

| 测试场景 | 输入／前置条件 | 预期结果 | 实际结果 |
| --- | --- | --- | --- |
| 新微信扫码 | 验证成功，账号识别 404/user.identity_not_exist | 显示新建/关联选择，不自动创建 | 纠正用例后旧代码失败，修复后通过 |
| 明确选择新建 | 上述选择页点击新用户 | 复用已验证微信证明进入 Register | 自动化通过 |
| 明确选择关联 | 上述选择页验证原账号 | 关联到原账号，禁止自动创建 | 自动化通过 |
| 已绑定微信 | 账号识别成功 | 直接登录，不改资料 | 自动化通过 |
| 其他错误 | 会话不存在、500、手机号专用不存在码 | 报错，不进入新用户分支 | 自动化通过 |

修复后的真实微信再次扫码仍需用户完成，不将自动化结果描述为真实扫码全链路通过。

本次实际执行：`pnpm --filter @delegate/auth-experience test` 最终 35 项通过；对应 `typecheck` 通过；保留批准 relay 的开发构建通过；`pnpm exec turbo run test --concurrency=1` 28/28 任务成功（27 个缓存复用）。HTTP 检查确认实际服务的脚本与修复构建完全一致，内容版本匹配且 relay 配置仍在。
