<p align="center">
  <img src="./docs/assets/delegate-hero.png" alt="Delegate 首图，展示金融、法务、医疗和创作者场景" width="100%" />
</p>

<p align="center">
  <a href="./README.zh-CN.md"><img alt="中文" src="https://img.shields.io/badge/中文-2563EB?style=for-the-badge" /></a>
  <a href="./README.md"><img alt="English" src="https://img.shields.io/badge/English-111827?style=for-the-badge" /></a>
</p>

# Delegate

把 Delegate 想成一个“AI 接待前台”。

当别人现在通过 Web，或通过可选的 Matrix、Telegram 等渠道来找你时，Delegate 会先让你的 AI 分身完成第一轮接待：

- 能回答的，先回答
- 该收费的，先收费
- 需要你拍板的，先请示你
- 需要人工接手的，再转给你

它的目标不是替代你，而是先把高频、标准化、可定价的对话接住，让你只在真正需要亲自出面的时刻介入。

Delegate 是 **Agent Monetization Network（AMN）** 的第一条产品楔子。AMN 是一个面向 AI Agents 和 Digital Representatives 的开放收益网络。

AMN 的长期命题很简单：任何 Agent 都可以赚钱，任何用户都可以充值，任何平台都可以接入，收益应该公开透明。Delegate 把这个命题先落成一个具体的公共数字代表：一个 web-first 接口，只基于已批准的公开知识回答问题，通过显式策略处理敏感操作，展示充值 / 服务深度，并在代表不该独立行动时转交给真人。

它不是把私人助理暴露给外部用户。Delegate 是一个独立的公共运行时，也是面向单个 Digital Representative 的充值 / 资料入口。

当前产品切口刻意保持很窄：

- Web-first representative runtime
- 公开 representative 页面和 public-safe chat
- founder representative demo data
- FAQ、intake、付费续聊和 owner handoff
- 通过网页服务 credits、invoices 和 sponsor pool state 形成早期 Agent Wallet 语义
- 通过隔离 broker 治理 compute
- approval expiration 和 handoff follow-up 的 durable timer

## 当前已经落地

Delegate 现在包含这些可运行的页面和服务：

- **营销站点** 位于 `apps/site`，使用 Dispatch Editorial 设计系统。
- **公开 representative 应用** 位于 `apps/reps`，包含代表档案、服务档位、网页聊天、充值入口模块，以及签名 public-chat session state。
- **Owner dashboard** 位于 `apps/web`，覆盖代表健康度、委托任务、governed actions、compute sessions、artifacts、deliverables、packages、代表级 Memory 配置、workflow state，以及 Owner 资料、身份安全和 Dashboard 通知设置。
- **可选 Telegram bot runtime** 位于 `apps/bot`，基于 grammY long-poll 和共享 Conversation Platform；它保留 Telegram 特有命令与交付边界，但不是第一版 Delegate 产品主入口。
- **可选 Matrix Application Service** 位于 `apps/matrix-bridge`，负责认证 Matrix transaction、映射渠道事件和管理虚拟用户。原生 Matrix 是独立的可选渠道，不是 Telegram 的必需中转层。
- **AMN wallet control plane** 覆盖不可变服务商品与价格、本地 mock、默认关闭的微信支付 API v3 Native 收款与恢复、服务权益、usage charging、Creator 暂定 20% 收益策略、退款/冲正、提现冻结、provider adapters，以及 owner/public wallet views。
- **Compute broker** 位于 `apps/compute-broker`，在 approval 和 policy gate 后提供受治理的 `exec`、`read`、`write`、`process` 和 `browser` 请求。
- **Agent Runtime V3** 横跨 `packages/runtime`、`packages/model-runtime`、conversation worker、Compute Broker 和 workflow runner：使用唯一的服务端验证 Goal/Action DAG、schema-pinned MCP 编译、原子执行准入、Verified Result 和证据绑定 Composer，并保留 V2 回滚兼容。
- **Workflow runner** 位于 `apps/workflow-runner`，支持 local runner 和 Temporal-backed durable workflow dispatch。
- **Prisma/Postgres 数据模型** 覆盖 representatives、contacts、conversations、delegation tasks、handoffs、approvals、invoices、compute、artifacts、deliverables、workflows 和 audit trails。
- **OpenViking 集成** 作为 PostgreSQL 权威数据之后的可重建投影，支持已发布公开知识与受治理记忆的同步和召回。
- **工作区技能治理** 支持 ClawHub 元数据发现、不可变版本固定、代表草稿绑定、MCP/Compute 就绪检查、统一审批/审计及签名补丁更新策略；不会执行第三方技能包代码。

当前真正实现的 durable workflow kind 有三个：

- `APPROVAL_EXPIRATION`
- `HANDOFF_FOLLOW_UP`
- `DELEGATION_EXECUTION`

Temporal 已经接入 post-commit command outbox dispatch、native workflow timer、cancellation cleanup、durable delegation signal 和 dashboard phase observability。普通实时聊天生成仍不会把业务真相放进 Temporal。

## AMN 目标模型

AMN 是 Delegate 正在走向的更大网络。目标模型是：

```text
Creator 创建 Agent
  -> Agent 获得自己的 Agent Wallet
  -> User 先在 Web 发现 Agent，未来再扩展到 Telegram、WhatsApp、飞书、企业微信或 App
  -> User 给这个具体 Agent 充值
  -> Agent 为 User 提供服务
  -> Billing 按 token、任务或订阅扣费
  -> Settlement 计算 Creator 收益
  -> Ledger 发布透明证明
```

AMN 目标层次包括：

- **AMN Pay:** 未来统一充值入口，可从任意平台拉起。
- **Billing Engine:** 按 token usage、completed tasks、subscriptions 或 service packages 计费。
- **Wallet Engine:** 管理每个 Agent / Digital Representative 的余额。
- **Settlement Engine:** 计算 Creator revenue、platform fees、provider costs 和 withdrawals。
- **Transparent Ledger:** 记录 recharge、charge、settlement 和 proof events，让用户和 creator 可以验证状态。

今天已经实现的是 web-first Delegate 楔子加上第一条 AMN 钱包闭环：公开 representative 页面、网页聊天、不可变服务套餐与价格版本、仅开发环境可用的 mock，以及默认关闭的微信支付 API v3 Native 下单、签名支付/退款通知、主动查单、幂等权益发放、未使用全额退款和自动对账。生产收款仍必须通过商户凭据预检、业务/法务条款确认和真实支付/退款 canary，不能仅因代码路径存在就打开收款开关。

仍未完全产品化的是：真实 Stripe SDK wiring 和 webhook signing、真实微信支付或支付宝 credential / certificate flow、通过 Stripe Connect / 支付宝转账 / 微信商家转账自动出金、通用开放 Wallet API、chargeback 自动化、Merkle proof 发布、多币种 FX，以及完整自动 settlement。

## AMN 钱包实现状态

目标架构是 **内部双账本 + 外部支付适配器**：

```text
Stripe / 微信支付 / 支付宝
  -> 负责收钱、退款、通知，未来负责出金

Delegate
  -> 负责用户余额、Agent tokens、Creator 20%、成本、利润、提现状态和审计账本
```

当前对照钱包方案的实现状态：

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 账户类型 | 已实现 | Prisma 已建模 `USER_CASH`、`AGENT_TOKEN`、`CREATOR_PENDING`、`CREATOR_WITHDRAWABLE`、`PLATFORM_REVENUE`、`PROVIDER_COST`。Creator earning 拆成 pending 和 withdrawable，方便按服务消耗释放和提现冻结。 |
| 数据模型 | 基本实现 | 已实现 `AudienceIdentity`、`UserWallet`、`AgentWallet`、`WalletLedgerEntry`、`RechargeOrder`、`PaymentProviderEvent`、`AgentTokenPurchase`、`AgentUsageCharge`、`CreatorEarning`、`WithdrawRequest`。公开用户以 canonical `AudienceIdentity` 归属钱包；`UserWallet.externalUserId` 仅保留为兼容支付选择器。 |
| 整数金额和 token | 已实现 | 钱全部用最小货币单位整数，例如 CNY fen、USD cents。Agent token 也是整数。 |
| 用户购买服务包 | 微信支付软件闭环已实现，生产开关默认关闭 | 浏览器只提交服务价格版本；服务端冻结金额、权益和分成快照，创建微信 Native 订单，验证签名通知/主动查询，幂等发放代表级服务权益，并支持未使用全额退款和对账。所有公开购买写操作都要求已验证的 Web 账户。 |
| 用户给 Agent 买 token | 已实现 | 服务会检查 `UserWallet`、扣用户现金、给 `AgentWallet` 增 token、生成 `AgentTokenPurchase`、按策略生成 Creator pending earning，并写 ledger。当前价格用每个 Agent 的 `tokenUnitPriceCents`，集中 price catalog 仍是后续工作。 |
| Agent 消耗 token | service 已实现 | `AgentUsageCharge` 会扣 Agent token、记录 provider cost / platform revenue，并把 Creator pending earning 按消耗释放到 withdrawable。纯 MCP 回答不要求 Pass，规划后会释放临时预占，也不消耗已购服务额度或免费回复次数；MCP 与非 MCP 混合任务仍按非 MCP 工作的计费合同执行。其他真实回复、compute 和 browser runtime 继续使用受治理的额度生命周期。 |
| Creator 提现 | MVP 已实现 | `WithdrawRequest` 会检查 verified owner、claimed representative 和 withdrawable balance，并冻结提现金额、写 ledger。Stripe Connect / 支付宝转账 / 微信商家转账自动打款还未实现。 |
| 退款和冲正 | 部分实现 | 已实现 paid recharge refund 和未消耗 token purchase reversal，并写 reversal ledger。完整 chargeback 自动处理和相关余额冻结仍是后续工作。 |
| 复用支付能力 | 微信支付 API v3 闭环已实现 | Mock 仅限开发；微信支付包含 Native 下单、证书/公钥验签、支付与退款通知、主动查询、超时恢复和 reconciliation。Stripe/支付宝仍是后续支付轨道。Delegate 不处理银行卡号、支付密码或原始敏感支付信息。 |
| 第一版不做 | 保持不做 | 不做自动跨境提现、Merkle proof、开放 Wallet API、待认领代表自动提现、链上账本、多币种汇兑。 |

Telegram 现在是可选渠道运行时。Bot 内数字商品和数字服务仍应遵循 Telegram 规则，包括在需要时使用 Telegram Stars；当前 Stars 生产收款保持关闭。Telegram 的付费继续入口会跳转到 Web 服务套餐/微信支付页面，必须先完成 Web 登录，并且只接受当前 Bot 下已经验证的 Telegram 绑定，确保服务权益落到同一个 Delegate 账户。只有 Bot 专用的 `TELEGRAM_WEB_RECHARGE_BASE_URL`（未配置时回退到 `NEXT_PUBLIC_REPRESENTATIVE_URL`）是公网 HTTPS origin，才会显示可点击的内联充值按钮。本地或其他非公网 HTTP 地址只会作为消息文本发送。

## 渠道架构方向

Delegate 当前以 Web 为主，并逐步收敛到一个渠道中立的 Conversation Platform，外部渠道只保留薄适配层：

- PostgreSQL 是身份、消息、生成、人工接管、服务权益和审计的业务真相。
- Web、原生 Matrix 和 Telegram 都是外部来源；Matrix 是可选渠道，不是 Telegram 的强制中枢。
- `sourceProvider` 记录用户从哪里发起交互，`transport` 记录事件通过什么链路传输。即使 Telegram 经可选 Matrix bridge 传输，它仍是 Telegram 来源。
- Telegram 与 Matrix 的 provider subject 只有经过各自的所有权证明后，才能绑定到统一 `AudienceIdentity`。Matrix ghost、bridge puppet、用户名和展示名都不是 Delegate 账号凭据。
- Web 支付与 Telegram Stars 是不同支付轨道。它们未来可以授予同一用户与代表范围内的服务权益，但余额、结算、退款和争议处理不会混用。
- 第一阶段渠道范围只覆盖私聊和纯文本，并按 representative 灰度启用；Telegram 保留直接适配器作为回滚路径。

已确认的边界、迁移顺序和回滚不变量见 [渠道 Conversation Platform ADR](./docs/adr-channel-conversation-platform.md)。

## 架构原则

Delegate 围绕几条硬边界构建：

- **Postgres 是业务真相。** 委托任务在 Postgres 中贯穿 workflow、billing、handoff、approval、outputs 和 dashboard state，不再把会话或某个 runtime session 当成任务本身。
- **渠道共享业务 runtime，不强制共享 transport。** Web、Matrix 和 Telegram 最终进入同一 Conversation Platform；Matrix 保持可选，不是 Telegram 的依赖。
- **Provider 身份必须经过 provider 证明。** 外部 subject 绑定到 `AudienceIdentity`；用户名、展示名、room membership、ghost 和 puppet 都不能单独证明账号归属。
- **服务权益可统一，支付轨道不混用。** Web 资金和 Telegram Stars 分别保留结算与退款语义，只在验证成功后授予 audience-scoped 服务访问。
- **Temporal 负责编排。** Temporal 负责长时 workflow timer 的 start、durable waiting、retry、wake-up 和 cancellation delivery。
- **公共代表不是私人工作区。** Runtime 不读取 owner-private files、accounts、secrets 或 hidden notes。
- **用户充值给某个 Agent，不是泛泛充值给平台。** 页面应该清楚说明余额属于哪个 Digital Representative。
- **Compute 隔离且受治理。** 通用命令和浏览器任务必须经过 compute broker、capability policy、audit records 和 owner-visible approvals。
- **Memory 有作用域。** OpenViking 存 representative-scoped public resources 和 public-safe long-term context，不存 owner-private state。
- **策略优先于 prompt 运气。** 敏感操作经过明确的 `allow`、`ask` 或 `deny` 决策，而不是只靠模型自觉。

## 工作区结构

```text
apps/
  bot/              Optional Telegram runtime foundation
  conversation-worker/ Durable channel generation and delivery worker
  compute-broker/   Isolated compute and browser broker
  matrix-bridge/    Optional native Matrix Application Service
  reps/             Public representative pages and public chat
  site/             Marketing website
  web/              Owner dashboard
  workflow-runner/  Local and Temporal workflow runner

packages/
  artifacts/          Artifact object-key and retention helpers
  capability-policy/  Capability gate evaluation primitives
  compute-protocol/   Typed compute broker payloads and schemas
  domain/             Shared schemas and demo representative data
  lifecycle-hooks/    Runtime lifecycle event hooks
  model-runtime/      Model context assembly and provider runtime
  openviking/         Typed OpenViking client, URI rules, and safety filters
  registry/           External skill registry clients
  runtime/            通用目标识别、多动作计划与结构化需求采集
  web-data/           Dashboard and public-page data access helpers
  web-ui/             Shared CSS/design system assets
  workflows/          Shared workflow kinds, inputs, and scheduling helpers

prisma/
  schema.prisma       Database schema
  migrations/         Prisma migrations

docs/
  architecture.md
  delegate-architecture-decisions.md
  temporal-native-workflow-rfc.md
  v2-isolated-compute-plane-plan.md
  openviking-integration.md
  roadmap.md
```

## 快速开始

前置条件：

- Node.js 20.18.1 或更高版本，以及 pnpm
- 如果要跑完整本地栈，需要 Docker
- 只有在需要真实模型或 OpenViking 调用时，才需要配置 provider API keys

安装依赖并创建本地环境变量文件：

```bash
pnpm install
cp .env.example .env
```

首次启动，或者修改了 `package.json`、锁文件、Dockerfile 后，执行一次完整初始化：

```bash
pnpm docker:bootstrap:local
```

本地 override 会让 Dashboard 和公开代表页使用 `next dev --turbopack`，并以只读
方式挂载应用及工作区包源码，同时继续启用内建开发身份并保持生产认证边界。日常启动
使用下面这个不主动构建镜像的命令。它会先幂等应用待执行的数据库迁移，再启动服务；
普通 TypeScript、TSX 和 CSS 修改会通过 Turbopack Fast Refresh 直接生效：

```bash
pnpm docker:up:local
```

`pnpm docker:up:local` 已包含 `pnpm docker:migrate:local`。如果服务已经在运行时修改了
Prisma schema，仍需重启 Dashboard 和 Reps 容器以重新生成 Prisma Client。依赖或镜像
层发生变化时，仍需执行 `pnpm docker:bootstrap:local`。

`pnpm docker:up` 用于 production-shaped 本地栈；creator 登录前必须先配置
Logto Traditional Web application。原生 Matrix 是可选渠道，也不是 Telegram
交付链路的必需依赖。配置 homeserver 和 Application Service secrets 后再启用
该 profile。`pnpm docker:up:matrix` 会继续加载相同的本地身份与稳定服务
override，并增加 Synapse 和 bridge；Dashboard 与公开代表页仍保持 Turbopack
开发服务器和源码热更新：

```bash
pnpm docker:up:matrix
```

运行标准检查：

```bash
pnpm verify
pnpm build
```

`pnpm verify` 会先生成 Prisma client、验证已提交的 schema，然后依次运行
workspace typecheck 和测试。

默认 Docker profile 的本地地址：

- Site: `http://localhost:3000`
- Dashboard: `http://localhost:3001/dashboard?view=overview`
- Representative: `http://localhost:3002/reps/lin-founder-rep`
- Dashboard liveness: `http://localhost:3001/health`
- Representative liveness: `http://localhost:3002/health`
- Compute broker health: `http://localhost:4010/health`
- Workflow runner health: `http://localhost:4020/health`
- Artifact store API: `http://localhost:9000`
- Artifact store console: `http://localhost:9001`
- OpenViking API: `http://localhost:1933`
- OpenViking console docs: `http://localhost:8020/docs`

如果你想手动并排运行三个 Next.js app，可以显式指定端口：

```bash
PORT=3100 pnpm dev:site
PORT=3101 pnpm dev:dashboard
PORT=3102 pnpm dev:reps
```

然后打开：

- Site: `http://localhost:3100`
- Dashboard: `http://localhost:3101/dashboard?view=overview`
- Representative: `http://localhost:3102/reps/lin-founder-rep`

如果只想为本地非 Docker app 开发启动数据库：

```bash
pnpm docker:up:db
pnpm db:setup
pnpm dev:site
pnpm dev:dashboard
pnpm dev:reps
pnpm dev:bot
```

## Temporal Workflow 模式

Delegate 默认使用内建 local runner：

```bash
WORKFLOW_ENGINE=local_runner
```

在 local-runner 模式下，到期的 workflow rows 会由 `apps/workflow-runner` 直接处理。

如果要运行 Temporal profile：

```bash
pnpm docker:up:temporal
```

这个 profile 会启动 Temporal、Temporal UI、namespace setup，以及带 Temporal 设置的 workflow runner。健康后可以检查：

- Temporal UI: `http://localhost:8233`
- Workflow runner: `http://localhost:4020/health`

健康检查应该返回 `engine: "temporal"`，并显示 Temporal bridge 正在运行。

当前 Temporal 模型是：

1. Producer 在同一次已提交的 Postgres flow 里写入 business truth、`WorkflowRun` 和 `WorkflowCommandOutbox`。
2. Workflow runner 在 commit 之后分发 `START`、`CANCEL` 和幂等 `SIGNAL` commands。
3. Temporal 用 `externalWorkflowId` 作为稳定幂等 key，立即启动 workflow。
4. Workflow 接收 `scheduledAt`，durably sleep 到对应时间，然后运行 DB-backed idempotent activity。
5. 手动解决业务状态时先更新 Postgres，并把 Temporal cancellation 视为 cleanup，而不是 authority。
6. 委托审批、用户补充、取消、策略撤销和 reconciliation signal 使用稳定的领域 ID；Temporal replay 不会重复推进同一个状态迁移。

`WORKFLOW_ENGINE` 会显式选择 workflow engine。`local_runner` 仍可用于本地开发，
也可由部署环境主动选择。如果已经选择 `temporal`，但地址、namespace 或 task
queue 配置不完整，Delegate 会以 `temporal_not_fully_configured` 失败关闭；不会
静默切换引擎，也不会创建无法处理的 Temporal workflow。

## 环境变量指南

默认 `.env.example` 适合本地开发。重要配置包括：

- `DATABASE_URL` 指向 Prisma 使用的 Postgres。
- `LOGTO_ENDPOINT` 与 `LOGTO_SCOPES` 是共享 OIDC 配置；Dashboard 只读取 `LOGTO_DASHBOARD_APP_ID` / `LOGTO_DASHBOARD_APP_SECRET`，Public Representatives 只读取 `LOGTO_REPS_APP_ID` / `LOGTO_REPS_APP_SECRET`。两者都从各自 canonical `NEXT_PUBLIC_*` origin 派生固定 `/auth/callback`，不会跨 namespace fallback，也不再读取 `LOGTO_REDIRECT_URI`。
- `LOGTO_BACKCHANNEL_ENDPOINT` 可为 token 与 JWKS 请求提供受信的服务端内网地址，但 authorize URL 与 issuer 校验始终使用公网 `LOGTO_ENDPOINT`。旧 Reps 动态回调只在完整 `LOGTO_REPS_LEGACY_*` tuple 和有效未来 `DELEGATE_REPS_LEGACY_CALLBACK_UNTIL` 下原地完成；否则在 token 请求前返回 `410`。
- `LOGTO_ACCOUNT_CENTER_URL` 可在 Owner Settings 中显示经过校验的 Logto 自助账户管理入口。生产值必须使用 HTTPS；本地开发可以使用 loopback HTTP。
- `DELEGATE_CREATOR_ADMISSION_MODE` 默认是 `invite_only`，经审核后可切换为 `self_service`。自助模式下只有短期签名 state 中明确携带 `flow=register` 的流程可以创建 Creator；普通登录不会把 Audience 自动升级成 Creator。邀请模式继续使用 `DELEGATE_CREATOR_ADMISSION_PRINCIPALS` 的精确 `issuer|subject` 白名单。
- `DELEGATE_ACCOUNT_SESSION_MODE=enforce|contract` 只读取数据库支持的 Dashboard/Reps opaque AppSession，不再回退旧签名 Cookie；Public AppSession 会保存经过登录证明绑定的浏览器 Audience ID。`LOGTO_WEBHOOK_SIGNING_KEY` 用于验证 `/api/auth/logto/webhook` 的原始请求体 HMAC，暂停、恢复和删除事件会同步 AuthIdentity 状态并撤销本地会话。
- `LOGTO_MANAGEMENT_APP_ID` / `LOGTO_MANAGEMENT_APP_SECRET` 只注入 workflow-runner；后台循环使用 client credentials 分页拉取完整 Logto 用户集合，修复漏发的暂停、恢复和删除事件。分页不完整或达到页数上限时失败关闭，绝不会据此推断用户已删除。shadow 模式还会输出不含 PII 的 legacy/v2 parity mismatch 事件，清零后才可切换 enforce。
- Owner Settings 的通知偏好目前只控制 Dashboard 导航提醒，不会启用 Email、SMS、Slack、Webhook 或免打扰时段。
- `NEXT_PUBLIC_DASHBOARD_URL` 和 `NEXT_PUBLIC_REPRESENTATIVE_URL` 是 production-shaped 应用必填的 canonical public origin。本地 override 会把它们固定为 loopback origin，避免复用远端环境文件时把开发登录重定向到远端主机。
- `TELEGRAM_WEB_RECHARGE_BASE_URL` 可只为 Bot 配置公网 Web 充值 origin，而不改变 representative app 自身的 canonical origin；未配置时回退到 `NEXT_PUBLIC_REPRESENTATIVE_URL`。只有公网 HTTPS 值会生成内联按钮，本地 HTTP 值只以文本发送。
- `DELEGATE_AUTH_SESSION_SECRET` 用于签名 Dashboard/Reps auth 与 callback-state cookie。Reps 固定回调的签名 state 同时携带 Representative slug 和完整匿名聊天绑定，不从 Host 或未签名 query 推导身份。生产环境必须使用强 secret。
- `DELEGATE_DASHBOARD_AUTH_MODE=required` 可以在非生产环境强制开启 dashboard 登录；生产环境始终要求登录。
- `DELEGATE_AUTH_DEV_LOGIN` 和 `DELEGATE_AUTH_DEV_*` 身份仅在非生产环境接受；`DELEGATE_LOCAL_AUTH_BOOTSTRAP=true` 独立允许本地 fixture 绑定步骤。`pnpm docker:up:local` 会开启这两个开关，不会削弱生产登录边界。
- `NEXT_PUBLIC_ENABLE_PUBLIC_DEMOS=true` 只显示带明确本地演示标识的 mock 操作，便于测试直接权益发放和未用额度退回；开发环境之外应保持为 `false`，mock mutation endpoints 在生产环境返回 `404`。该开关不启用微信支付。真实微信 Native 下单、签名支付/退款通知、主动查询和退款恢复由独立的 `DELEGATE_WECHAT_PAY_*` 发布开关与凭据预检控制。
- `DELEGATE_SKILL_TRUSTED_KEYS` 是 registry 发布者 key ID 到受信 Ed25519 公钥 PEM 的 JSON 映射；缺少匹配公钥时不会自动采纳签名补丁版本。
- `DELEGATE_CLAWHUB_URL` 指定不含凭据的 HTTPS Registry origin，`DELEGATE_CLAWHUB_ALLOWED_HOSTS` 限制允许的主机名，`DELEGATE_CLAWHUB_TRUST_MAX_AGE_MS` 限制 exact-version 验证的新鲜度（默认 24 小时），且客户端拒绝重定向。采纳或回滚前会重新获取精确发布者/版本的 manifest 与 verdict，拒绝过期或发生漂移的证据，并使用当前受信公钥集合重验签后才改变 release 状态。
- 当前 Telegram long-poll runtime 只要求 `TELEGRAM_BOT_TOKEN`。`TELEGRAM_BOT_ID` 可选，未填写时会从 token 的数字前缀推导；`getMe` 成功后，Bot 会把验证过的 ID 和 username 写入已配置的 Telegram 渠道绑定，Web 因此无需拿到 token 也能生成限定当前连接的 `/bind` 挑战。建议填写 `TELEGRAM_BOT_USERNAME` 以获得可读的渠道标识，但它不影响 polling 启动。`TELEGRAM_WEBHOOK_SECRET` 不会被 long-poll 读取，也不是 long-poll 必需项；它仍可供独立 webhook、签名或 fallback 逻辑使用，但不应只为启动 polling 而配置。
- `REP_PUBLIC_CHAT_SESSION_SECRET` 可以覆盖 public-chat cookie 签名 secret。如果没有设置，reps app 会依次回退到 `TELEGRAM_WEBHOOK_SECRET` 和本地开发 secret。
- `PUBLIC_CHAT_RATE_LIMIT_SECRET` 会先对网络、用户和数字代表限流键做 HMAC，再写入 Postgres；未配置时回退到 `REP_PUBLIC_CHAT_SESSION_SECRET`。三个 `PUBLIC_CHAT_*_REQUESTS_*` 变量用于调整分布式准入限额。只有受信反向代理会覆盖指定请求头时才设置 `PUBLIC_CHAT_CLIENT_IP_HEADER`，否则保持为空。
- `PUBLIC_MATERIAL_LINK_SECRET` 用于签发十分钟有效、绑定数字代表、资料校验和与处理版本的公开资料链接。下载时会重新检查当前发布和审批状态，因此资料归档、停用、替换或取消公开后，已签发链接也会失效。
- `DELEGATE_MODEL_ENABLED`、`DELEGATE_MODEL_PROVIDER`、`DELEGATE_MODEL_FALLBACK_PROVIDER` 和各 Provider 的模型配置控制 model-backed representative replies。`DELEGATE_MODEL_PLANNER_PROVIDER` 可将规划独立固定到支持原生 Strict Structured Outputs 的 Provider；本地默认建议优先 `agicto`，已配置的 AGICTO、OpenAI 和兼容百炼模型均走原生 Strict JSON Schema。默认主回答 Provider 也是独立的 `agicto`。
- `TURN_PLAN_V3_MODE` 控制权威 Agent Runtime 发布（`disabled | shadow | active_readonly | active_governed`）。V3 active 只运行一次 V3 Planner，不调用 V2 或旧 natural-language Detailed Planner；公开数字代表先查授权知识，只有用户本轮明确允许通用来源、Knowledge 为 Verified miss/unavailable 且服务端确认非 Owner 权威事实时，才带固定说明回退通用知识；`active_governed` 再发布托管 Markdown/TXT、typed Compute 和 schema-pinned MCP。
- 生产环境的 V3 active 还要求 `TURN_PLAN_V3_ACTIVE_RELEASE_APPROVED=true`；只有对应 Lane 通过可执行 Shadow release gate 后才能设置。
- `TURN_PLANNER_V2_MODE` 只控制 V2 回滚/兼容（`disabled | shadow | active_low_risk`）；V3 active 时 V2 不会成为第二套写入真相。
- `DELEGATE_AGICTO_API_KEY` 启用 AGICTO；未单独配置时可以复用现有 `OPENVIKING_MODEL_API_KEY` 与 `OPENVIKING_MODEL_API_BASE`。AGICTO 仅在线路协议上兼容 OpenAI，不会被记录成 OpenAI Provider，也不会借用 `OPENAI_API_KEY`。长文档通过 `DELEGATE_MODEL_DOCUMENT_TIMEOUT_MS`、`DELEGATE_MODEL_DOCUMENT_MAX_OUTPUT_TOKENS` 和 `DELEGATE_MODEL_DOCUMENT_MAX_PARTS` 设置独立超时、单段预算和有界续写段数。
- `OPENVIKING_*` 控制 public memory sync、recall 和 commit 行为。
- `COMPUTE_*` 控制 broker、Docker runner、browser image 和 native computer-use readiness。`COMPUTE_MCP_CATALOG_REFRESH_INTERVAL_MS` 默认 120 秒，应小于外部 Capability 5 分钟 Availability TTL。
- `scripts/docker-compose-local.sh` 会从当前仓库目录动态注入 `COMPUTE_HOST_WORKSPACE_ROOT`。不要再提交某个开发者机器的绝对路径；直接使用 Compose 时应显式提供宿主机路径，或使用当前 `PWD` 回退。
- `CONVERSATION_OUTBOX_PROCESSING_LEASE_MS` 默认是 5 分钟，最小也是 5 分钟；conversation worker 会为仍在执行的生成任务续租。
- `WORKFLOW_*` 控制 local-runner 与 Temporal workflow execution。
- `ARTIFACT_STORE_*` 控制 MinIO-backed artifact storage；宿主机工具使用 `ARTIFACT_STORE_ENDPOINT`，Compose 内服务使用 `ARTIFACT_STORE_DOCKER_ENDPOINT`（默认 `http://artifact-store:9000`），避免容器误连自身的 localhost。
- `KNOWLEDGE_OBJECT_STORE_*` 控制知识原文件对象存储，默认私有桶固定为 `delegate-1324808004`；腾讯云 COS 可使用 S3 兼容 endpoint，并将 `FORCE_PATH_STYLE` 设为 `false`。

知识文件会先持久化到对象存储，再由后台任务重新读取原文件、解析正文、规范化与分块，并写入 OpenViking 向量索引。只有对象、正文和向量索引全部成功后，资产才会进入 `READY`；归档和永久删除会同步移除向量索引，避免已撤权内容继续被召回。

当 model providers 不可用时，旧的纯展示路径仍可使用 deterministic preview；V3 active 的规划、证据、工具执行和 Composer 会失败关闭，绝不会把缺失的工具/证据结果改成模型猜测。

## 常用命令

```bash
pnpm dev:site
pnpm dev:dashboard
pnpm dev:reps
pnpm dev:bot
pnpm dev:compute-broker
pnpm dev:workflow-runner

pnpm db:generate
pnpm db:validate
pnpm db:migrate:dev
pnpm db:deploy
pnpm db:seed
pnpm db:setup

pnpm test:channels
pnpm test:channels:pg16
pnpm test:postgres:owner-settings

pnpm docker:ps
pnpm docker:logs
pnpm docker:down
pnpm docker:up:local
pnpm docker:up:matrix

pnpm registry:search:clawhub "qualification"
```

`pnpm docker:down` 也会停止通过 Matrix 或 Temporal profile 启动的服务，但不会
删除本地数据库或其他 named volumes。

`pnpm test:channels` 是不需要渠道凭据的离线门禁：它会清空开发机上的 provider
credentials，再测试并 typecheck Web、Matrix、Telegram、conversation worker、
Dashboard 和公开 representative packages。`pnpm test:channels:pg16` 在此基础上
使用可销毁的 PostgreSQL 16 fixture，验证跨渠道身份、消息、服务权益、并发和迁移兼容性；
它不会连接当前配置的应用数据库。
`pnpm test:postgres:owner-settings` 同样会创建并销毁独立的 PostgreSQL 16 容器，
从空库应用全部迁移，并验证 Owner Settings 的 CAS、幂等、并发、审计、通知与公开身份边界。

发布 Owner Settings 时，应先应用三项增量设置迁移，再部署应用。两个仅含单条
`CREATE INDEX CONCURRENTLY` 的迁移不能被人工包进大事务。若应用发布失败，
应先回滚应用并保留这些向前兼容的 schema 增量，不执行破坏性的数据库降级。

### 工作区技能迁移上线

仓库门禁默认只读，并要求显式声明目标环境，以及一份近期备份凭证。凭证指纹同时覆盖
PostgreSQL 协议、主机、端口和数据库名。门禁还会读取所有已完成且未回滚的
`_prisma_migrations.checksum`，并与本地对应 `migration.sql` 的 SHA-256 逐一比较：

```bash
pnpm test:migration-gate

scripts/workspace-skill-release-gate.sh \
  --environment staging \
  --backup-proof /absolute/path/to/backup-proof.json
```

凭证 JSON 必须包含 `environment`、`databaseTargetFingerprint`、
`snapshotId`、`createdAt` 和 `restoreVerifiedAt`。请使用门禁实际读取的
`DATABASE_URL` 生成不含密钥的目标指纹；`restoreVerifiedAt` 必须对应
这份备份的恢复演练，因此不能早于 `createdAt`：

```bash
node -e 'const c=require("node:crypto");const u=new URL(process.env.DATABASE_URL);const p=u.protocol.replace(/:$/,"").toLowerCase();const h=u.hostname.replace(/^\[|\]$/g,"").toLowerCase();const n=u.port||"5432";const d=decodeURIComponent(u.pathname.replace(/^\/+/, ""));console.log(c.createHash("sha256").update([p,h,n,d].join("|")).digest("hex").slice(0,16))'
```

如果宿主机没有安装 `psql`，本地 Compose 数据库可以这样执行同一份只读预检：

```bash
docker compose exec -T postgres psql \
  -U postgres \
  -d delegate \
  -X \
  --set ON_ERROR_STOP=1 \
  --file - \
  < prisma/preflight/workspace-skill-legacy-version-conflicts.sql
```

直接调用 `psql` 时必须设置等待上限，避免发布任务无限等待：

```bash
PGOPTIONS="-c lock_timeout=5s -c statement_timeout=5min" \
  psql "$DATABASE_URL" \
  -X \
  --set ON_ERROR_STOP=1 \
  --file prisma/preflight/workspace-skill-legacy-version-conflicts.sql
```

预检的每一行代表一个 owner/skill 歧义组。`issueCodes` 会区分
`missing_version`、`version_conflict` 和 `status_conflict`；即使所有
binding 的版本相同，只要 `installed` 与 `update_available` 状态不一致也会报告。
`bindingCount`、`representativeCount`、`affectedReleaseCount` 和
`affectedPendingApprovalCount` 用于估算维护窗口；部署前必须保存报告并人工确认选中的 owner/version。

迁移 `20260723220000_reconcile_legacy_multi_representative_skill_versions`
只会从非空历史 binding 中按 `updatedAt DESC, id DESC` 选择 winner。
`SkillPack.version` 只是目录元数据，绝不会被当作已经采用的证据。有有效 winner
时，冲突 binding 会统一到该版本但全部禁用，安装进入 `NEEDS_REVIEW`，其他历史版本保留为
`REJECTED` 不可运行记录。如果所有历史版本都是 NULL/空白，迁移不会创建 installed release，
而是清空 installed version 与 binding 采用字段、把 binding 降为 `available` 并禁用，
同时拒绝由目录元数据迁出的 candidate 及其 pending approval。
`WorkspaceSkillInstall.installedAt` 是旧 schema 中的 NOT NULL 审计时间，不作为运行授权。
只有存在具体历史基线时，更高目录版本才能作为未采用
`CANDIDATE` 保留并等待 owner 审批。迁移不会启用任何 binding，也不会放宽 ClawHub 信任隔离。

叠加式迁移 `20260723224000_workspace_skill_legacy_ambiguity_corrective`
用于处理已经执行过旧版 backfill 的数据库。它同时识别当前仍可见的歧义，以及旧版
reconciliation 的精确 review-note 标记，避免已被旧迁移归一化的冲突绕过隔离。
该迁移可重复收敛；在当前 fresh migration chain 上不会产生数据变更。

批准备份凭证前，必须将备份恢复到一个全新、空白、可随时销毁的 local 或 staging 数据库；严禁恢复到生产库：

```bash
pg_dump "$DATABASE_URL" \
  --format=custom \
  --file /secure/path/delegate-pre-migration.dump

pg_restore \
  --exit-on-error \
  --single-transaction \
  --dbname "$DISPOSABLE_RESTORE_DATABASE_URL" \
  /secure/path/delegate-pre-migration.dump

DATABASE_URL="$DISPOSABLE_RESTORE_DATABASE_URL" \
  pnpm exec prisma migrate status --schema prisma/schema.prisma
```

维护窗口清单：

1. 暂停 Dashboard 写入、worker、bot，以及会修改技能、版本、审批或代表绑定的任务。
2. 核对备份文件、保留策略、目标指纹和一次成功的可销毁恢复演练；凭证应保存在仓库之外。
3. 执行只读门禁、归档报告并人工确认每个 winner。已应用迁移的 checksum 不一致会无条件阻断并列出迁移名，
   不提供自动 override；数据库尚未应用的本地迁移不会误报。存在冲突时，本地演练路径还必须显式传入
   `--conflicts-reviewed`。
4. 设置 `lock_timeout` 和 `statement_timeout`，持续观察锁等待、WAL、磁盘、复制延迟和应用错误。
5. 通过批准的部署流水线执行迁移。脚本会拒绝 staging/production 自动部署；只有显式 localhost 演练可以使用 `--mode deploy --maintenance-confirmed --allow-local-deploy`。
6. 部署后重新运行预检并要求 0 行；`prisma migrate status` 必须为 up-to-date，随后验证安装、审批、代表发布和 MCP 调用，再恢复写流量。

部署前 `prisma migrate status` 可以显示 pending migration，这是预期状态；failed migration
或已应用 checksum 不一致必须立即阻断。checksum 不一致必须进入批准后的人工迁移历史排查；
叠加式数据纠偏不会消除 Prisma 的历史 checksum 警告。部署后 pending 和 failed 都会阻断写流量恢复。

真实 PostgreSQL 并发测试也是发布门禁：

```bash
pnpm test:postgres:skills
pnpm test:migration-fixture:pg16
```

这些测试只能连接可修改、可销毁的 local 或 staging 测试库，严禁指向生产。
PG16 migration fixture 会自行创建并销毁 Docker 数据库，覆盖 NULL/空白版本、状态混用、
多版本历史、更高目录版本、release/approval 最终状态和 postflight 收敛。对于大数据量环境，
它还会复现“旧迁移已应用且目录版本被错误当成 installed”的状态，验证随后只执行一条
additive corrective、关闭错误 approval、保留但不采用合法目录 candidate，并把 preflight
收敛为 0 行。应先在 staging 验证锁和 WAL 影响，因为纠偏会在同一事务中更新
installation、release、approval 和 binding。

第一版产品主路径优先 dogfood 浏览器代表页 `http://localhost:3102/reps/lin-founder-rep`，以及 owner dashboard `http://localhost:3101/dashboard?view=overview`。

## 设计系统

Delegate 使用 [DESIGN.md](./DESIGN.md) 中定义的 **Dispatch Editorial** 方向：

- 温暖的 paper 和 parchment surfaces
- sea-ink 和 copper signal colors
- editorial marketing pages
- procedural、dense owner dashboard views
- trust disclosures 靠近 primary actions

项目在 build 时使用 resilient local CSS font fallbacks。如果之后需要精确的 Instrument Sans、Instrument Serif 或 IBM Plex Mono 渲染，应改为 self-host font files，而不是依赖 build-time Google Fonts fetch。

## 文档地图

- [Architecture](./docs/architecture.md): product thesis、runtime loop、security boundary 和 OpenViking rules。
- [Agent Runtime V3](./docs/agent-runtime-v3.md): PlannerProposal、TurnPlan、能力、审批、执行、证据、交付、计费、发布门槛和 pi 框架决策的权威规范。
- [Conversation runtime flow](./docs/conversation-runtime-flow.md): 渠道中立的 V3 运行流程。
- [Architecture decisions](./docs/delegate-architecture-decisions.md): 更大的系统方向和 tradeoffs。
- [Public audience identity](./docs/public-audience-identity.md): Web 匿名身份、Contact/Conversation、充值和 sandbox linkage。
- [Conversation platform](./docs/conversation-platform.md): 渠道中立消息、episode、版本、人工接管、SSE 和 Matrix Application Service 边界。
- [Channel Conversation Platform ADR](./docs/adr-channel-conversation-platform.md): source/transport 分离、身份校验、Web/Stars 权益、渠道 MVP、迁移和回滚决策。
- [Delegation tasks](./docs/delegation-tasks.md): 委托任务聚合、生命周期、归属校验、审批、产物和审计关联。
- [Delegation task product contract](./docs/delegation-task-product-contract.md): 任务创建、可见状态、Owner 操作、审批绑定、完成标准和 P0 边界。
- [Temporal-native workflow RFC](./docs/temporal-native-workflow-rfc.md): workflow state model、outbox、timer、cancellation 和 dashboard semantics。
- [V2 isolated compute plane plan](./docs/v2-isolated-compute-plane-plan.md): compute 和 browser isolation model。
- [OpenViking integration](./docs/openviking-integration.md): public memory 和 recall integration。
- [Roadmap](./docs/roadmap.md): 分阶段产品和平台方向。
- [Gap analysis](./docs/gap-analysis.md): 剩余产品和架构缺口。
- [Design system](./DESIGN.md): 视觉方向和 implementation notes。

## 当前边界

Delegate 可以：

- 基于公开 representative knowledge 回答问题
- 收集 structured intake
- 提供 paid continuation
- 展示 web-first 充值 / 服务深度 UI 和 invoice records
- 为特定 Digital Representative 展示早期 Agent Wallet / recharge-entry 状态
- 创建 owner handoff requests
- 通过 broker 运行 governed compute 和 browser tasks
- 持久化 artifacts、deliverables、package downloads、audit events 和 ledgers
- 通过 durable workflow timers 处理 approval expiration 和 handoff follow-up

Delegate 明确不会：

- 暴露 owner-private workspace memory
- 从 representative runtime 运行任意 host commands
- 静默修改真实 calendar 或 private accounts
- 把 raw Temporal history 当作业务真相
- 把普通聊天回复迁进 long-running workflows
- 信任客户端传来的 public-chat tier 或 recent-turn state 作为权威
- 在能力未落地前声称 AMN Pay、提现、通用 wallet APIs、自动 settlement 或 Merkle proofs 已经交付
