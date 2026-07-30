import type { Locale } from "@delegate/web-ui";

export type DashboardView =
  | "overview"
  | "knowledge"
  | "representatives"
  | "inbox"
  | "approvals"
  | "skills"
  | "wallet"
  | "memory"
  | "analytics"
  | "channels"
  | "audit"
  | "settings";

type LocalizedText = Record<Locale, string>;

export type DashboardNavItem = {
  id: DashboardView;
  index: string;
  label: LocalizedText;
  shortLabel: LocalizedText;
};

export type DashboardSectionBlueprint = {
  title: LocalizedText;
  eyebrow: LocalizedText;
  description: LocalizedText;
  primaryAction: LocalizedText;
  tabs: LocalizedText[];
  metrics: Array<{
    label: LocalizedText;
    value: string;
    detail: LocalizedText;
    tone?: "teal" | "indigo" | "warning";
  }>;
  table: {
    title: LocalizedText;
    description: LocalizedText;
    columns: LocalizedText[];
    rows: Array<Array<LocalizedText>>;
  };
  modules: Array<{
    title: LocalizedText;
    description: LocalizedText;
    items: LocalizedText[];
    status?: LocalizedText;
  }>;
};

const text = (zh: string, en: string): LocalizedText => ({ zh, en });

export const dashboardNavigation: Array<{
  label: LocalizedText;
  items: DashboardNavItem[];
}> = [
  {
    label: text("工作台", "Workspace"),
    items: [
      { id: "overview", index: "00", label: text("总览", "Overview"), shortLabel: text("总览", "Overview") },
      { id: "knowledge", index: "01", label: text("知识库", "Knowledge Library"), shortLabel: text("知识", "Knowledge") },
      { id: "representatives", index: "02", label: text("数字代表", "Digital Representatives"), shortLabel: text("代表", "Representatives") },
      { id: "inbox", index: "03", label: text("会话与线索", "Inbox"), shortLabel: text("会话", "Inbox") },
      { id: "approvals", index: "04", label: text("待审批 Action", "Approvals"), shortLabel: text("审批", "Approvals") },
    ],
  },
  {
    label: text("能力与收益", "Capability & revenue"),
    items: [
      { id: "skills", index: "05", label: text("技能 / 工具", "Skills & Tools"), shortLabel: text("技能", "Skills") },
      { id: "wallet", index: "06", label: text("钱包 / 账单", "Wallet & Billing"), shortLabel: text("钱包", "Wallet") },
      { id: "memory", index: "07", label: text("公开记忆", "Public Memory"), shortLabel: text("记忆", "Memory") },
      { id: "analytics", index: "08", label: text("数据分析", "Analytics"), shortLabel: text("分析", "Analytics") },
      { id: "channels", index: "09", label: text("发布渠道", "Channels"), shortLabel: text("渠道", "Channels") },
    ],
  },
  {
    label: text("系统", "System"),
    items: [
      { id: "audit", index: "10", label: text("审计日志", "Audit Logs"), shortLabel: text("审计", "Audit") },
      { id: "settings", index: "11", label: text("设置", "Settings"), shortLabel: text("设置", "Settings") },
    ],
  },
];

export const dashboardSectionBlueprints: Record<
  Exclude<DashboardView, "overview" | "settings">,
  DashboardSectionBlueprint
> = {
  knowledge: {
    eyebrow: text("Knowledge Library", "Knowledge Library"),
    title: text("把所有知识资产收进一套可复用、可授权的资料库。", "Keep every knowledge asset reusable, traceable, and permissioned."),
    description: text("上传文件、URL 或手动文本，查看处理状态，并决定哪些代表可以使用、哪些内容可以公开。", "Upload files, URLs, or notes, inspect processing state, and control which representatives may use or publish them."),
    primaryAction: text("上传知识文件", "Upload knowledge"),
    tabs: [text("文件列表", "Files"), text("上传知识文件", "Upload"), text("文件详情", "Details"), text("知识权限", "Permissions")],
    metrics: [
      { label: text("知识文件", "Knowledge files"), value: "24", detail: text("工作区内全部来源", "Across this workspace"), tone: "teal" },
      { label: text("已处理", "Processed"), value: "19", detail: text("可用于问答与生成", "Ready for Q&A and generation") },
      { label: text("处理中", "Processing"), value: "03", detail: text("正在提取与打标签", "Extracting and tagging") },
      { label: text("需处理", "Needs attention"), value: "02", detail: text("权限或解析存在问题", "Permission or parsing issues"), tone: "warning" },
    ],
    table: {
      title: text("知识文件", "Knowledge files"),
      description: text("搜索、筛选并追踪每个来源的处理和授权状态。", "Search, filter, and track processing and access for every source."),
      columns: [text("文件名", "Name"), text("类型", "Type"), text("处理状态", "Status"), text("可见范围", "Visibility"), text("关联代表", "Representatives")],
      rows: [
        [text("Founder profile.pdf", "Founder profile.pdf"), text("PDF", "PDF"), text("已处理", "Processed"), text("Selected reps", "Selected reps"), text("Lin AI", "Lin AI")],
        [text("服务与报价.md", "Services & pricing.md"), text("Markdown", "Markdown"), text("已处理", "Processed"), text("Public material", "Public material"), text("2 个代表", "2 reps")],
        [text("品牌介绍.docx", "Brand introduction.docx"), text("DOCX", "DOCX"), text("处理中", "Processing"), text("Owner only", "Owner only"), text("未关联", "Unassigned")],
      ],
    },
    modules: [
      { title: text("上传与处理", "Upload & process"), description: text("统一接收 PDF、DOCX、TXT、Markdown、URL 和手动文本。", "Accept PDF, DOCX, TXT, Markdown, URLs, and manual notes."), items: [text("添加标签", "Add tags"), text("设置权限范围", "Set visibility"), text("开始处理", "Start processing")], status: text("框架已就绪", "UI ready") },
      { title: text("知识权限", "Knowledge access"), description: text("权限是知识资产的一部分，而不是发布之后的补丁。", "Permissions travel with the asset rather than becoming a publishing afterthought."), items: [text("Owner only", "Owner only"), text("Organization shared", "Organization shared"), text("Selected representatives", "Selected representatives"), text("Public material", "Public material")] },
    ],
  },
  representatives: {
    eyebrow: text("Digital Representatives", "Digital Representatives"),
    title: text("从知识、边界到价格，发布一个完整的数字代表。", "Publish a complete digital representative from knowledge to boundaries and pricing."),
    description: text("创建、配置、预览和发布数字代表，并在同一处查看它们的运行状态。", "Create, configure, preview, and publish representatives while keeping their operating state visible."),
    primaryAction: text("创建数字代表", "Create representative"),
    tabs: [text("代表列表", "Representatives"), text("创建数字代表", "Create"), text("代表详情", "Details"), text("发布检查", "Publish checklist")],
    metrics: [
      { label: text("数字代表", "Representatives"), value: "04", detail: text("工作区总数", "Workspace total"), tone: "teal" },
      { label: text("已发布", "Published"), value: "03", detail: text("正在公开接待", "Live public interfaces") },
      { label: text("草稿", "Drafts"), value: "01", detail: text("尚未完成发布校验", "Not publish-ready") },
      { label: text("今日会话", "Conversations today"), value: "18", detail: text("来自全部代表", "Across all representatives"), tone: "indigo" },
    ],
    table: {
      title: text("代表列表", "Representative directory"),
      description: text("快速判断发布状态、知识完整度和公开入口。", "Scan publishing state, knowledge coverage, and public entry points."),
      columns: [text("代表名称", "Representative"), text("状态", "Status"), text("知识文件", "Knowledge"), text("FAQ / 服务", "FAQ / Services"), text("最近发布", "Last published")],
      rows: [
        [text("Lin 的数字代表", "Lin's digital representative"), text("已发布", "Published"), text("12 个文件", "12 files"), text("18 / 6", "18 / 6"), text("今天 09:42", "Today 09:42")],
        [text("Delegate 产品顾问", "Delegate product advisor"), text("已发布", "Published"), text("8 个文件", "8 files"), text("12 / 4", "12 / 4"), text("昨天", "Yesterday")],
        [text("招聘接待代表", "Recruiting front desk"), text("草稿", "Draft"), text("3 个文件", "3 files"), text("6 / 2", "6 / 2"), text("尚未发布", "Not published")],
      ],
    },
    modules: [
      { title: text("代表配置", "Representative setup"), description: text("八个清晰步骤替代一张无限延伸的设置表单。", "Eight explicit stages replace an endless settings form."), items: [text("基础信息", "Identity"), text("知识来源", "Knowledge"), text("FAQ", "FAQ"), text("服务范围", "Services"), text("安全边界", "Boundaries"), text("免费额度 / 价格", "Pricing"), text("发布", "Publish"), text("运行数据", "Operations")] },
      { title: text("发布检查", "Publish checklist"), description: text("发布前确认身份、知识、边界、价格和人工接手路径。", "Verify identity, knowledge, boundaries, pricing, and human handoff before going live."), items: [text("Preview public page", "Preview public page"), text("Test chat", "Test chat"), text("Public URL / QR code", "Public URL / QR code")], status: text("6 / 8 已完成", "6 / 8 complete") },
    ],
  },
  inbox: {
    eyebrow: text("Inbox", "Inbox"),
    title: text("把会话、Intake 和人工接手收进同一条处理队列。", "Turn conversations, intake, and human handoff into one operating queue."),
    description: text("先看谁需要回复、为什么值得跟进，以及代表已经收集了哪些上下文。", "See who needs a response, why they matter, and what context the representative already collected."),
    primaryAction: text("打开优先队列", "Open priority queue"),
    tabs: [text("会话列表", "Conversations"), text("Conversation 详情", "Conversation detail"), text("Intake", "Intake"), text("Handoff", "Handoff")],
    metrics: [
      { label: text("未读会话", "Unread"), value: "12", detail: text("等待查看的新消息", "New messages to review"), tone: "teal" },
      { label: text("Intake", "Intake"), value: "07", detail: text("已完成结构化需求", "Structured requests ready") },
      { label: text("待接手", "Needs handoff"), value: "04", detail: text("建议主人亲自处理", "Recommended for owner"), tone: "warning" },
      { label: text("已付费", "Paid"), value: "05", detail: text("本周进入的付费会话", "Paid conversations this week"), tone: "indigo" },
    ],
    table: {
      title: text("会话与线索", "Conversations and leads"),
      description: text("按用户、来源代表、意图、付款和推荐动作排序。", "Triage by user, representative, intent, payment, and recommended action."),
      columns: [text("用户", "User"), text("来源代表", "Representative"), text("Intent", "Intent"), text("状态", "Status"), text("推荐动作", "Recommended action")],
      rows: [
        [text("Alex Chen", "Alex Chen"), text("Lin 的数字代表", "Lin's representative"), text("Collaboration", "Collaboration"), text("Reviewing", "Reviewing"), text("安排 20 分钟沟通", "Schedule 20 min call")],
        [text("Mina / Acme", "Mina / Acme"), text("产品顾问", "Product advisor"), text("Pricing", "Pricing"), text("待处理", "Open"), text("确认预算范围", "Confirm budget")],
        [text("匿名访客 #184", "Visitor #184"), text("招聘接待代表", "Recruiting desk"), text("Materials", "Materials"), text("已完成", "Closed"), text("无需人工接手", "No handoff needed")],
      ],
    },
    modules: [
      { title: text("Intake 摘要", "Intake summary"), description: text("把用户身份、需求、预算、时间线和优先级压缩成可决策摘要。", "Compress identity, demand, budget, timeline, and priority into a decision-ready brief."), items: [text("用户身份", "Identity"), text("需求摘要", "Request summary"), text("预算与时间线", "Budget & timeline"), text("推荐下一步", "Recommended next step")] },
      { title: text("Handoff 状态", "Handoff states"), description: text("人工接手必须有明确的生命周期。", "Every human handoff needs an explicit lifecycle."), items: [text("待处理", "Open"), text("Reviewing", "Reviewing"), text("Accepted", "Accepted"), text("Declined / Closed", "Declined / Closed")], status: text("4 条待处理", "4 open") },
    ],
  },
  approvals: {
    eyebrow: text("Approvals", "Approvals"),
    title: text("在敏感 Action 执行前，把风险、上下文和后果讲清楚。", "Make risk, context, and consequences clear before sensitive actions execute."),
    description: text("审批不是弹窗确认，而是一条可追踪、可过期、可审计的决策记录。", "Approval is a traceable, expiring, auditable decision record rather than a generic confirmation dialog."),
    primaryAction: text("处理待审批", "Review pending actions"),
    tabs: [text("审批列表", "Approval queue"), text("审批详情", "Approval detail"), text("已解决", "Resolved"), text("策略", "Policy")],
    metrics: [
      { label: text("待审批", "Pending"), value: "05", detail: text("等待主人决策", "Awaiting owner decision"), tone: "warning" },
      { label: text("高风险", "High risk"), value: "02", detail: text("需要优先查看", "Needs immediate review") },
      { label: text("即将过期", "Expiring soon"), value: "01", detail: text("30 分钟内自动关闭", "Closes within 30 minutes") },
      { label: text("本周通过", "Approved this week"), value: "18", detail: text("平均 12 分钟处理", "12 min average resolution"), tone: "teal" },
    ],
    table: {
      title: text("待审批 Action", "Pending actions"),
      description: text("按风险、请求时间和过期时间处理敏感动作。", "Review sensitive actions by risk, request time, and expiry."),
      columns: [text("Action 类型", "Action"), text("来源代表", "Representative"), text("用户 / 会话", "User / conversation"), text("风险", "Risk"), text("过期时间", "Expires")],
      rows: [
        [text("发送报价文件", "Send proposal file"), text("Lin 的数字代表", "Lin's representative"), text("Alex Chen", "Alex Chen"), text("高", "High"), text("28 分钟", "28 min")],
        [text("浏览器提交表单", "Submit browser form"), text("产品顾问", "Product advisor"), text("Mina / Acme", "Mina / Acme"), text("中", "Medium"), text("2 小时", "2 hours")],
        [text("调用 CRM MCP", "Call CRM MCP"), text("销售接待代表", "Sales front desk"), text("Conversation #932", "Conversation #932"), text("中", "Medium"), text("5 小时", "5 hours")],
      ],
    },
    modules: [
      { title: text("审批详情", "Approval detail"), description: text("决策前展示请求摘要、风险说明、AI 建议和相关聊天上下文。", "Show request summary, risk, AI recommendation, and chat context before a decision."), items: [text("Action payload", "Action payload"), text("Approve / Reject", "Approve / Reject"), text("审批备注", "Decision note")], status: text("需要 Owner", "Owner required") },
      { title: text("策略边界", "Policy boundary"), description: text("allow / ask first / deny 决定动作进入哪条路径。", "allow / ask first / deny determines which path an action can take."), items: [text("Delegate managed", "Delegate managed"), text("Owner managed", "Owner managed"), text("Organization policy", "Organization policy"), text("Customer account", "Customer account")] },
    ],
  },
  skills: {
    eyebrow: text("Skills & Tools", "Skills & Tools"),
    title: text("扩展能力，但不扩大代表的默认权限。", "Expand capability without expanding default authority."),
    description: text("安装技能、绑定代表、设置审批策略，并集中管理 MCP、Browser 和 Compute 能力。", "Install skills, bind representatives, set approval policies, and govern MCP, browser, and compute capabilities."),
    primaryAction: text("浏览技能市场", "Browse registry"),
    tabs: [text("已安装技能", "Installed"), text("技能市场", "Registry"), text("技能详情", "Skill detail"), text("MCP / Compute", "MCP / Compute")],
    metrics: [
      { label: text("已安装", "Installed"), value: "08", detail: text("工作区技能总数", "Workspace skills"), tone: "teal" },
      { label: text("已启用", "Enabled"), value: "06", detail: text("至少绑定一个代表", "Bound to at least one rep") },
      { label: text("需要审批", "Approval required"), value: "04", detail: text("敏感工具调用", "Sensitive tool calls"), tone: "warning" },
      { label: text("更新可用", "Updates"), value: "02", detail: text("可审核的新版本", "New versions to review"), tone: "indigo" },
    ],
    table: {
      title: text("已安装技能", "Installed skills"),
      description: text("查看来源、风险、绑定代表和审批要求。", "Inspect source, risk, representative bindings, and approval requirements."),
      columns: [text("技能名称", "Skill"), text("来源", "Source"), text("状态", "Status"), text("风险", "Risk"), text("绑定代表", "Representatives")],
      rows: [
        [text("Lead qualification", "Lead qualification"), text("builtin", "builtin"), text("已启用", "Enabled"), text("低", "Low"), text("3 个代表", "3 reps")],
        [text("Public material delivery", "Public material delivery"), text("registry", "registry"), text("已启用", "Enabled"), text("中", "Medium"), text("2 个代表", "2 reps")],
        [text("Browser research", "Browser research"), text("owner_upload", "owner_upload"), text("已暂停", "Paused"), text("高", "High"), text("1 个代表", "1 rep")],
      ],
    },
    modules: [
      { title: text("技能详情", "Skill detail"), description: text("能力说明、支持 intents、参数、审批策略和调用记录集中展示。", "Keep capability, intents, parameters, approval policy, and call history together."), items: [text("参数与绑定", "Parameters & bindings"), text("审批策略", "Approval policy"), text("调用记录", "Call history")] },
      { title: text("MCP / Compute 能力", "MCP / Compute"), description: text("通用能力必须留在隔离、计费和审计边界内。", "General capability stays inside isolation, billing, and audit boundaries."), items: [text("MCP bindings", "MCP bindings"), text("Browser capability", "Browser capability"), text("Exec / Read / Write / Process", "Exec / Read / Write / Process"), text("Policy profile", "Policy profile")], status: text("隔离运行", "Isolated") },
    ],
  },
  wallet: {
    eyebrow: text("Wallet & Billing", "Wallet & Billing"),
    title: text("看清楚钱从哪里来、花到哪里、何时可以提现。", "See where money comes from, where it goes, and when it becomes withdrawable."),
    description: text("把服务包购买、权益发放、使用扣费、创作者收益、退款和内部账本放在一条可解释的资金链上。", "Connect service-package purchases, entitlement grants, usage, creator earnings, refunds, and ledger entries into one explainable money flow."),
    primaryAction: text("查看账本明细", "View ledger"),
    tabs: [text("钱包概览", "Overview"), text("服务包购买", "Service packages"), text("使用扣费", "Usage"), text("提现", "Withdrawals"), text("退款 / 冲正", "Refunds"), text("账本明细", "Ledger")],
    metrics: [
      { label: text("代表服务额度", "Representative credits"), value: "—", detail: text("从实时账本读取", "Loaded from the live ledger"), tone: "teal" },
      { label: text("本月收入", "Revenue this month"), value: "—", detail: text("从实时账本读取", "Loaded from the live ledger") },
      { label: text("待释放收益", "Pending earnings"), value: "—", detail: text("随服务消耗释放", "Released as service is consumed") },
      { label: text("可提现", "Withdrawable"), value: "—", detail: text("完成结算后可用", "Available after settlement"), tone: "indigo" },
    ],
    table: {
      title: text("最近交易", "Recent transactions"),
      description: text("按事件组追踪购买、权益发放、扣费、收入和冲正。", "Trace purchase, entitlement, usage, revenue, and reversal by event group."),
      columns: [text("事件", "Event"), text("账户类型", "Account"), text("金额 / 数量", "Amount"), text("状态", "Status"), text("时间", "Time")],
      rows: [],
    },
    modules: [
      { title: text("资金流", "Money flow"), description: text("外部支付负责收钱；Delegate 内部账本负责服务权益、收益、成本和审计。", "Payment providers collect funds; Delegate tracks service entitlements, earnings, cost, and audit state."), items: [text("购买服务包", "Service-package purchase"), text("发放代表专属权益", "Representative entitlement grant"), text("Usage charge", "Usage charge"), text("Creator settlement", "Creator settlement")] },
      { title: text("提现与退款", "Withdrawals & refunds"), description: text("提现先冻结，退款与冲正必须保留原事件关联。", "Withdrawals freeze funds first; refunds and reversals retain original event links."), items: [text("发起提现", "Request withdrawal"), text("提现审核", "Withdrawal review"), text("Refund / reversal", "Refund / reversal"), text("Chargeback", "Chargeback")] },
    ],
  },
  memory: {
    eyebrow: text("Public Memory", "Public Memory"),
    title: text("公开记忆必须能看到来源、范围和每次召回。", "Public memory should expose provenance, scope, and every recall."),
    description: text("管理代表级记忆、用户会话摘要、公开资源，并检查 Recall 与 Commit traces。", "Govern representative memory, conversation summaries, public resources, recall traces, and commit traces."),
    primaryAction: text("同步公开资源", "Sync public resources"),
    tabs: [text("记忆概览", "Overview"), text("Memory records", "Memory records"), text("Recall traces", "Recall traces"), text("Commit traces", "Commit traces")],
    metrics: [
      { label: text("公开记忆", "Public memories"), value: "42", detail: text("代表与用户范围", "Representative and user scopes"), tone: "teal" },
      { label: text("公开资源", "Public resources"), value: "19", detail: text("最近一次成功同步", "Last successful sync") },
      { label: text("今日召回", "Recalls today"), value: "28", detail: text("进入回复链路", "Injected into responses") },
      { label: text("同步异常", "Sync issues"), value: "01", detail: text("需要检查来源", "Source needs review"), tone: "warning" },
    ],
    table: {
      title: text("Memory records", "Memory records"),
      description: text("查看 URI、Scope、Category、Summary 和来源。", "Inspect URI, scope, category, summary, and provenance."),
      columns: [text("URI", "URI"), text("Scope", "Scope"), text("Category", "Category"), text("来源", "Source"), text("状态", "Status")],
      rows: [
        [text("viking://resources/.../profile", "viking://resources/.../profile"), text("Representative", "Representative"), text("Identity", "Identity"), text("Founder profile.pdf", "Founder profile.pdf"), text("启用", "Enabled")],
        [text("viking://user/memories/.../184", "viking://user/memories/.../184"), text("Contact", "Contact"), text("Preference", "Preference"), text("Conversation #184", "Conversation #184"), text("启用", "Enabled")],
        [text("viking://agent/memories/.../handoff", "viking://agent/memories/.../handoff"), text("Agent", "Agent"), text("Pattern", "Pattern"), text("Owner feedback", "Owner feedback"), text("待审核", "Review")],
      ],
    },
    modules: [
      { title: text("Recall traces", "Recall traces"), description: text("记录 query、命中 URI、score 和 layer，回答为什么使用这条记忆。", "Record query, URI, score, and layer to explain why memory was used."), items: [text("Query", "Query"), text("Recalled URI", "Recalled URI"), text("Score / Layer", "Score / Layer")] },
      { title: text("Commit traces", "Commit traces"), description: text("每次保存都带有 Session、原因、提取结果和状态。", "Every commit carries session, reason, extracted results, and state."), items: [text("Session ID", "Session ID"), text("Commit reason", "Commit reason"), text("Extracted memories", "Extracted memories"), text("Status", "Status")], status: text("边界正常", "Boundary healthy") },
    ],
  },
  analytics: {
    eyebrow: text("Analytics", "Analytics"),
    title: text("从访问到付费，读懂每个代表的接待与转化效率。", "Understand every representative from first visit through paid conversion."),
    description: text("按代表、用户意图、渠道和收入拆解访问、会话、Intake、Handoff 与付费。", "Break down visits, conversations, intake, handoff, and payment by representative, intent, channel, and revenue."),
    primaryAction: text("导出分析报告", "Export report"),
    tabs: [text("总览", "Overview"), text("按代表分析", "By representative"), text("用户意图", "Intent"), text("收入分析", "Revenue")],
    metrics: [
      { label: text("访问量", "Visits"), value: "2,480", detail: text("最近 30 天", "Last 30 days"), tone: "teal" },
      { label: text("会话数", "Conversations"), value: "684", detail: text("27.6% 访问转会话", "27.6% visit-to-chat") },
      { label: text("Handoff", "Handoffs"), value: "86", detail: text("12.6% 会话升级", "12.6% escalated") },
      { label: text("付费转化", "Paid conversion"), value: "8.4%", detail: text("较上月 +1.2%", "+1.2% month over month"), tone: "indigo" },
    ],
    table: {
      title: text("按代表分析", "Representative performance"),
      description: text("比较会话、FAQ 命中、未回答、Handoff 与收入。", "Compare conversations, FAQ hits, unanswered questions, handoff, and revenue."),
      columns: [text("代表", "Representative"), text("会话", "Conversations"), text("FAQ 命中", "FAQ hit"), text("Handoff", "Handoff"), text("收入", "Revenue")],
      rows: [
        [text("Lin 的数字代表", "Lin's representative"), text("342", "342"), text("72%", "72%"), text("38", "38"), text("¥1,640", "¥1,640")],
        [text("Delegate 产品顾问", "Delegate product advisor"), text("218", "218"), text("68%", "68%"), text("31", "31"), text("¥920", "¥920")],
        [text("招聘接待代表", "Recruiting front desk"), text("124", "124"), text("61%", "61%"), text("17", "17"), text("¥300", "¥300")],
      ],
    },
    modules: [
      { title: text("用户意图", "Intent mix"), description: text("看清用户为什么而来，以及哪些意图没有被满足。", "See why users arrive and where demand remains unanswered."), items: [text("FAQ · 42%", "FAQ · 42%"), text("Collaboration · 21%", "Collaboration · 21%"), text("Pricing · 16%", "Pricing · 16%"), text("Scheduling / Materials / Handoff", "Scheduling / Materials / Handoff")] },
      { title: text("收入分析", "Revenue analysis"), description: text("按代表、计划、渠道和时间拆分收入。", "Slice revenue by representative, plan, channel, and time."), items: [text("按代表", "By representative"), text("按计划", "By plan"), text("按渠道", "By channel"), text("按时间", "Over time")], status: text("本月 +18%", "+18% this month") },
    ],
  },
  channels: {
    eyebrow: text("Channels", "Channels"),
    title: text("先把 Web 入口发布清楚，再逐步扩展消息渠道。", "Publish the web entry clearly before expanding into messaging channels."),
    description: text("集中管理公开链接、QR code、Embed、SEO，以及未来 Telegram、WhatsApp、飞书、企微和 API。", "Manage public URLs, QR code, embed, SEO, and future Telegram, WhatsApp, Feishu, WeCom, and API channels."),
    primaryAction: text("配置 Web Public Page", "Configure public page"),
    tabs: [text("Web Public Page", "Web Public Page"), text("Telegram", "Telegram"), text("WhatsApp", "WhatsApp"), text("Feishu / WeCom", "Feishu / WeCom"), text("API", "API")],
    metrics: [
      { label: text("Web 页面", "Web pages"), value: "03", detail: text("当前已公开", "Currently public"), tone: "teal" },
      { label: text("Embed", "Embeds"), value: "01", detail: text("已部署站点", "Deployed site") },
      { label: text("Telegram", "Telegram"), value: "Beta", detail: text("Bot runtime 基础已连接", "Bot runtime foundation connected"), tone: "indigo" },
      { label: text("后续渠道", "Future channels"), value: "04", detail: text("WhatsApp / 飞书 / 企微 / API", "WhatsApp / Feishu / WeCom / API") },
    ],
    table: {
      title: text("发布渠道", "Published channels"),
      description: text("查看每个渠道的状态、入口和能力范围。", "Inspect state, entry point, and capability scope for each channel."),
      columns: [text("渠道", "Channel"), text("状态", "Status"), text("入口", "Entry"), text("支付", "Payment"), text("激活策略", "Activation")],
      rows: [
        [text("Web Public Page", "Web Public Page"), text("已发布", "Published"), text("delegate.ai/reps/lin", "delegate.ai/reps/lin"), text("Web recharge", "Web recharge"), text("Always available", "Always available")],
        [text("Telegram", "Telegram"), text("Beta", "Beta"), text("t.me/delegate_demo", "t.me/delegate_demo"), text("Stars", "Stars"), text("Private / mention", "Private / mention")],
        [text("Embed widget", "Embed widget"), text("试运行", "Pilot"), text("acme.com/advisor", "acme.com/advisor"), text("Web recharge", "Web recharge"), text("Page load", "Page load")],
      ],
    },
    modules: [
      { title: text("Web Public Page", "Web Public Page"), description: text("每个代表都有独立公开 URL、分享预览和嵌入能力。", "Every representative has a public URL, sharing preview, and embed surface."), items: [text("Public URL", "Public URL"), text("QR code", "QR code"), text("Embed widget", "Embed widget"), text("SEO / 分享设置", "SEO / sharing")] },
      { title: text("消息渠道", "Messaging channels"), description: text("消息平台是受渠道规则约束的接入层，不是绕过支付与隐私政策的捷径。", "Messaging platforms are policy-bound channels, not shortcuts around payment or privacy rules."), items: [text("Telegram", "Telegram"), text("WhatsApp · 后续", "WhatsApp · Later"), text("Feishu / WeCom · 后续", "Feishu / WeCom · Later"), text("API · 后续", "API · Later")], status: text("Web-first", "Web-first") },
    ],
  },
  audit: {
    eyebrow: text("Audit Logs", "Audit Logs"),
    title: text("每一次发布、审批、付款和工具调用都应该可追踪。", "Every publish, approval, payment, and tool call should be traceable."),
    description: text("按时间、事件类型、操作者、代表、会话和 Trace ID 还原系统发生了什么。", "Reconstruct what happened by time, event type, actor, representative, conversation, and trace ID."),
    primaryAction: text("导出审计日志", "Export audit log"),
    tabs: [text("事件列表", "Events"), text("事件详情", "Event detail"), text("筛选", "Filters"), text("导出", "Export")],
    metrics: [
      { label: text("今日事件", "Events today"), value: "186", detail: text("全部系统事件", "All system events"), tone: "teal" },
      { label: text("审批事件", "Approval events"), value: "24", detail: text("请求与决策", "Requests and decisions") },
      { label: text("钱包事件", "Wallet events"), value: "38", detail: text("充值、扣费、结算", "Recharge, usage, settlement") },
      { label: text("异常事件", "Anomalies"), value: "02", detail: text("需要安全复核", "Needs security review"), tone: "warning" },
    ],
    table: {
      title: text("事件列表", "Event log"),
      description: text("用统一事件语言连接业务状态和运行轨迹。", "Connect business state and runtime traces with one event language."),
      columns: [text("时间", "Time"), text("事件类型", "Event type"), text("操作者", "Actor"), text("代表", "Representative"), text("摘要", "Summary")],
      rows: [
        [text("10:42:18", "10:42:18"), text("APPROVAL_RESOLVED", "APPROVAL_RESOLVED"), text("owner@delegate.ai", "owner@delegate.ai"), text("Lin AI", "Lin AI"), text("允许发送报价文件", "Proposal delivery approved")],
        [text("10:31:04", "10:31:04"), text("WALLET_USAGE_CHARGED", "WALLET_USAGE_CHARGED"), text("system", "system"), text("Product Advisor", "Product Advisor"), text("Browser 使用扣费 18 credits", "Browser usage charged 18 credits")],
        [text("09:52:47", "09:52:47"), text("REPRESENTATIVE_PUBLISHED", "REPRESENTATIVE_PUBLISHED"), text("owner@delegate.ai", "owner@delegate.ai"), text("Recruiting Desk", "Recruiting Desk"), text("发布版本 v0.8", "Published version v0.8")],
      ],
    },
    modules: [
      { title: text("事件详情", "Event detail"), description: text("保留 payload、前后状态、相关资源和 Trace ID。", "Retain payload, before/after state, related resources, and trace ID."), items: [text("Payload", "Payload"), text("前后状态", "Before / after"), text("相关资源", "Related resources"), text("Trace ID", "Trace ID")] },
      { title: text("事件筛选", "Event filters"), description: text("从业务动作进入审计，而不是在原始日志里搜索。", "Enter audit from business actions rather than searching raw logs."), items: [text("发布事件", "Publishing"), text("审批事件", "Approvals"), text("钱包事件", "Wallet"), text("工具调用", "Tool calls"), text("登录 / 设置", "Login / settings")], status: text("保留 180 天", "180-day retention") },
    ],
  },
};

export function localize(locale: Locale, value: LocalizedText): string {
  return value[locale];
}

export function isDashboardView(value: string | undefined): value is DashboardView {
  return dashboardNavigation.some((group) => group.items.some((item) => item.id === value));
}
