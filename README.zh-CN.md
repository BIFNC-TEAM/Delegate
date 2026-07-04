<p align="center">
  <img src="./docs/assets/delegate-hero.png" alt="Delegate 首图，展示金融、法务、医疗和创作者场景" width="100%" />
</p>

<p align="center">
  <a href="./README.zh-CN.md"><img alt="中文" src="https://img.shields.io/badge/中文-2563EB?style=for-the-badge" /></a>
  <a href="./README.md"><img alt="English" src="https://img.shields.io/badge/English-111827?style=for-the-badge" /></a>
</p>

# Delegate

把 Delegate 想成一个“AI 接待前台”。

当别人通过 Telegram、WhatsApp、飞书等渠道来找你时，Delegate 会先让你的 AI 分身完成第一轮接待：

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
- **Owner dashboard** 位于 `apps/web`，覆盖代表健康度、governed actions、compute sessions、artifacts、deliverables、packages、OpenViking traces 和 workflow state。
- **可选 Telegram bot runtime 基础** 位于 `apps/bot`，基于 grammY 和共享 runtime policy，作为未来渠道基础设施保留，不作为第一版 Delegate 产品主入口。
- **AMN wallet control plane** 覆盖内部钱包 ledger、mock recharge、Agent token purchase、usage charging、Creator 20% revenue policy、refund/reversal services、withdrawal request freeze、provider adapters，以及 owner/public wallet views。
- **Compute broker** 位于 `apps/compute-broker`，在 approval 和 policy gate 后提供受治理的 `exec`、`read`、`write`、`process` 和 `browser` 请求。
- **Workflow runner** 位于 `apps/workflow-runner`，支持 local runner 和 Temporal-backed durable workflow dispatch。
- **Prisma/Postgres 数据模型** 覆盖 representatives、contacts、conversations、handoffs、approvals、invoices、compute、artifacts、deliverables、workflows 和 audit trails。
- **OpenViking 集成** 支持 representative-scoped public resources、recall、session commit traces 和 safe memory previews。
- **ClawHub registry primitives** 为后续非特权 representative skill packs 做准备。

当前真正实现的 durable workflow kind 只有两个：

- `APPROVAL_EXPIRATION`
- `HANDOFF_FOLLOW_UP`

Temporal 已经为这两个 workflow 接入 post-commit command outbox dispatch、native workflow timer、cancellation cleanup 和 dashboard phase observability。普通实时聊天路由仍然不会放进 Temporal。

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

今天已经实现的是 web-first Delegate 楔子加上第一条 AMN 钱包闭环：公开 representative 页面、网页聊天、pricing tiers、公开 mock recharge、用户现金余额、Agent token purchase、Agent token usage charging、Creator pending / withdrawable earning、withdrawal request freeze、refund/reversal services、owner wallet dashboard、provider adapter boundaries 和 durable follow-up workflows。

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
| 数据模型 | 基本实现 | 已实现 `UserWallet`、`AgentWallet`、`WalletLedgerEntry`、`RechargeOrder`、`PaymentProviderEvent`、`AgentTokenPurchase`、`AgentUsageCharge`、`CreatorEarning`、`WithdrawRequest`。目前还没有独立通用 `User` 表，公开用户先用 `UserWallet.externalUserId` 表示。 |
| 整数金额和 token | 已实现 | 钱全部用最小货币单位整数，例如 CNY fen、USD cents。Agent token 也是整数。 |
| 用户充值 | mock 闭环已实现 | 已实现 `RechargeOrder` 创建、mock payment success、幂等 provider event、`UserWallet` 入账和 wallet ledger。 |
| 用户给 Agent 买 token | 已实现 | 服务会检查 `UserWallet`、扣用户现金、给 `AgentWallet` 增 token、生成 `AgentTokenPurchase`、按策略生成 Creator pending earning，并写 ledger。当前价格用每个 Agent 的 `tokenUnitPriceCents`，集中 price catalog 仍是后续工作。 |
| Agent 消耗 token | service 已实现 | `AgentUsageCharge` 会扣 Agent token、记录 provider cost / platform revenue，并把 Creator pending earning 按消耗释放到 withdrawable。它还没有自动接到所有真实回复、compute、browser、MCP runtime 路径上。 |
| Creator 提现 | MVP 已实现 | `WithdrawRequest` 会检查 verified owner、claimed representative 和 withdrawable balance，并冻结提现金额、写 ledger。Stripe Connect / 支付宝转账 / 微信商家转账自动打款还未实现。 |
| 退款和冲正 | 部分实现 | 已实现 paid recharge refund 和未消耗 token purchase reversal，并写 reversal ledger。完整 chargeback 自动处理和相关余额冻结仍是后续工作。 |
| 复用支付能力 | adapter 边界已实现 | Mock provider 可用。Stripe Checkout 风格 adapter 已通过 injected client 边界实现。微信支付和支付宝 adapter 是 fail-closed 骨架，需要官方 SDK / OpenAPI 回调和验签后才能启用。Delegate 不处理银行卡号、支付密码或原始敏感支付信息。 |
| 第一版不做 | 保持不做 | 不做自动跨境提现、Merkle proof、开放 Wallet API、待认领代表自动提现、链上账本、多币种汇兑。 |

Telegram 是未来渠道基础设施。如果 Delegate 后续提供 bot 内数字商品和数字服务，仍应遵循 Telegram 规则，包括在需要时使用 Telegram Stars。AMN Pay 是未来 Web / 统一充值路径，不是绕过平台政策的理由。

## 架构原则

Delegate 围绕几条硬边界构建：

- **Postgres 是业务真相。** Workflow、billing、handoff、approval 和 dashboard state 都来自 Postgres 记录。
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
  compute-broker/   Isolated compute and browser broker
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
  runtime/            Inquiry classification and action-gate policy
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

- Node.js 和 pnpm
- 如果要跑完整本地栈，需要 Docker
- 只有在需要真实模型或 OpenViking 调用时，才需要配置 provider API keys

安装依赖并创建本地环境变量文件：

```bash
pnpm install
cp .env.example .env
```

启动完整 Docker Compose 本地栈：

```bash
pnpm docker:up
```

运行标准检查：

```bash
pnpm typecheck
pnpm test
pnpm build
```

默认 Docker profile 的本地地址：

- Site: `http://localhost:3000`
- Dashboard: `http://localhost:3001/dashboard?view=overview`
- Representative: `http://localhost:3002/reps/lin-founder-rep`
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
2. Workflow runner 在 commit 之后分发 `START` 和 `CANCEL` commands。
3. Temporal 用 `externalWorkflowId` 作为稳定幂等 key，立即启动 workflow。
4. Workflow 接收 `scheduledAt`，durably sleep 到对应时间，然后运行 DB-backed idempotent activity。
5. 手动解决业务状态时先更新 Postgres，并把 Temporal cancellation 视为 cleanup，而不是 authority。

如果 Temporal 配置不完整，Delegate 会回退到 `local_runner`，不会把任务塞进无法处理的 Temporal 队列。

## 环境变量指南

默认 `.env.example` 适合本地开发。重要配置包括：

- `DATABASE_URL` 指向 Prisma 使用的 Postgres。
- `LOGTO_ENDPOINT`、`LOGTO_APP_ID`、`LOGTO_APP_SECRET`、`LOGTO_REDIRECT_URI` 和 `LOGTO_SCOPES` 启用兼容 Logto OIDC 的 creator dashboard 登录。
- `DELEGATE_AUTH_SESSION_SECRET` 用于签名 dashboard auth 和 callback-state cookie。生产环境必须使用强 secret。
- `DELEGATE_DASHBOARD_AUTH_MODE=required` 可以在非生产环境强制开启 dashboard 登录；生产环境始终要求登录。
- `TELEGRAM_BOT_TOKEN`、`TELEGRAM_BOT_USERNAME` 和 `TELEGRAM_WEBHOOK_SECRET` 启用可选 Telegram bot 基础设施，但第一版 Delegate 产品先做网页版。
- `REP_PUBLIC_CHAT_SESSION_SECRET` 可以覆盖 public-chat cookie 签名 secret。如果没有设置，reps app 会依次回退到 `TELEGRAM_WEBHOOK_SECRET` 和本地开发 secret。
- `DELEGATE_MODEL_ENABLED`、`DELEGATE_MODEL_PROVIDER`、`DELEGATE_OPENAI_MODEL` 和 `DELEGATE_ANTHROPIC_MODEL` 控制 model-backed representative replies。
- `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 或 `ARK_API_KEY` 启用真实 provider 调用。
- `OPENVIKING_*` 控制 public memory sync、recall 和 commit 行为。
- `COMPUTE_*` 控制 broker、Docker runner、browser image 和 native computer-use readiness。
- `WORKFLOW_*` 控制 local-runner 与 Temporal workflow execution。
- `ARTIFACT_STORE_*` 控制 MinIO-backed artifact storage。

当 model providers 不可用时，bot 和 public representative 路径会回退到 deterministic previews，而不是让对话失败。

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

pnpm docker:ps
pnpm docker:logs
pnpm docker:down

pnpm registry:search:clawhub "qualification"
```

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
- [Architecture decisions](./docs/delegate-architecture-decisions.md): 更大的系统方向和 tradeoffs。
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
