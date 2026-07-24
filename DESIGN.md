# Design System — Delegate

## Product Context
- **What this is:** Delegate is a web-first AI front desk and public representative system. It turns an agent into a public-facing interface for a founder, advisor, creator, recruiter, or operator, with explicit trust boundaries, bounded skills, human handoff, and paid continuation.
- **Who it's for:** Inbound-heavy operators who need a durable public representative, plus the external users who need to understand and trust that representative quickly.
- **Space/industry:** Agent interface, operator tooling, creator monetization, trust-first AI product infrastructure.
- **Project type:** Hybrid system: marketing site, public representative page, and owner control-plane dashboard.

## Competitive Landscape
- **Linear:** Shows how AI can feel native to a workflow instead of bolted on. Calm surfaces, high-density information, and strong hierarchy make the product feel fast and opinionated.
- **Vercel:** Shows how infrastructure products communicate trust through disciplined grids, crisp contrast, and concrete product surfaces instead of vague futurism.
- **LangSmith:** Shows how observability products make complexity legible with clear sectioning, explicit use cases, and operational confidence.
- **Intercom:** Shows how to narrate AI + human cooperation as one system, not two disconnected products.
- **beehiiv:** Shows how creator and monetization products present ambition, growth, and commercial upside without looking like enterprise admin software.

## First-Principles Insight
- Delegate should **not** look like a private AI assistant.
- Delegate should **not** look like a generic black-glass AI infrastructure startup.
- Delegate should **not** look like a cheerful creator landing page with weak operational gravity.
- Delegate should look like a **public delegation interface**:
  - trusted enough for strangers
  - operational enough for owners
  - commercial enough to justify paid access
  - structured enough to hint at the future Agent Network layer

## Aesthetic Direction
- **Direction:** Dispatch Editorial
- **Decoration level:** Intentional
- **Mood:** Clear, composed, and operational. The website is the confident public front door; the dashboard is its quieter workspace counterpart. Both should feel like one modern product family: less "AI lab", more "trusted operating system for digital representatives".
- **Reference sites:** [Linear](https://linear.app), [Vercel](https://vercel.com), [LangSmith](https://www.langchain.com/langsmith), [Intercom](https://www.intercom.com), [beehiiv](https://www.beehiiv.com)

## Safe Choices
- Use a disciplined dashboard grid, strong status chips, and clear table/card hierarchy. Operator products need scanability before personality.
- Keep trust disclosures explicit and visually close to primary actions. Delegate wins when boundaries are legible.
- Use high contrast typography and restrained surfaces so dense control-plane views stay usable.

## Risks Worth Taking
- Use an editorial display scale inside a restrained sans-serif system. The personality should come from rhythm, hierarchy, and product language rather than decorative type switching.
- Use teal as the living-system signal and indigo as the decision/automation signal on clean white and cool-gray surfaces. This gives the product a recognizable operating language without falling into generic dark-glass AI styling.
- Make the marketing site declarative and the dashboard procedural, while keeping the same colors, typography, border language, and motion behavior across both.

## Typography
- **Display/Hero:** Avenir Next / SF Pro Display / PingFang SC — matches the current Site implementation and keeps product headlines clear, modern, and product-led.
- **Body:** Avenir Next / SF Pro Text / PingFang SC — compact enough for the control plane while remaining calm and readable.
- **UI/Labels:** Same sans-serif family with stronger weight, tighter sizing, and restrained uppercase for navigation groups and operational eyebrows.
- **Data/Tables:** IBM Plex Mono / SFMono Regular / Consolas — use for numbers, IDs, timestamps, wallet values, action indices, and traces.
- **Code:** IBM Plex Mono / SFMono Regular / Consolas.
- **Loading:** Prefer project-local CSS font variables and resilient system fallbacks. Do not introduce build-time font network requests.
- **Scale:**
  - hero-display: `5.5rem / 88px`
  - display-1: `4rem / 64px`
  - display-2: `3rem / 48px`
  - h1: `2.25rem / 36px`
  - h2: `1.75rem / 28px`
  - h3: `1.375rem / 22px`
  - body-lg: `1.125rem / 18px`
  - body: `1rem / 16px`
  - body-sm: `0.875rem / 14px`
  - micro: `0.75rem / 12px`

## Color
- **Approach:** Site-aligned light operating system.
- **Primary:** `#16A394` — Delegate teal. Use for primary actions, active navigation, healthy system states, public/live signals, and trusted links.
- **Primary strong:** `#0D9488` — hover, high-contrast teal copy, and compact status labels.
- **Primary soft:** `#F0FDFA` / `#CCFBF1` — selected navigation, trusted surfaces, and low-intensity system feedback.
- **Secondary:** `#6366F1` — indigo. Use for automation, approvals, decision queues, account identity, and secondary data emphasis.
- **Secondary soft:** `#EEF2FF` — preview, automation, and decision surfaces.
- **Neutrals:**
  - `#FFFFFF` — primary surface
  - `#F9FAFB` — raised/secondary surface
  - `#F7F8FA` — dashboard canvas
  - `#E5E7EB` — default ruled line
  - `#9CA3AF` — faint labels and indexes
  - `#6B7280` — muted copy
  - `#374151` — secondary ink
  - `#111827` — primary ink
- **Semantic:**
  - success `#0D9488`
  - warning `#D97706`
  - error `#DC2626`
  - info `#6366F1`
- **Dark mode:** Not part of the current Dashboard v2 scope. If introduced later, derive it from the same teal/indigo semantics rather than creating a separate neon/glass identity.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable in marketing, compact-comfortable in dashboard
- **Scale:** 2xs(2) xs(4) sm(8) md(12) lg(16) xl(24) 2xl(32) 3xl(48) 4xl(64) 5xl(96)

## Layout
- **Approach:** Hybrid
- **Grid:**
  - marketing: 12 columns desktop, 8 tablet, 4 mobile
  - dashboard: fixed `280px` left workspace rail + sticky global top bar + fluid content stage
  - public representative page: 12-column structure with strong summary header and two-zone content split
- **Max content width:**
  - marketing: `1280px`
  - dashboard: `1440px`
  - reading/detail sections: `72ch` max for long copy
- **Border radius:**
  - xs: `8px`
  - sm: `10-12px`
  - md: `14-16px`
  - lg: `24-28px` for marketing hero modules only
  - full: `9999px`

## Motion
- **Approach:** Intentional
- **Principles:**
  - no floaty ambient gimmicks
  - movement should imply routing, switching, revealing, and escalation
  - the dashboard should feel responsive, not playful
  - the marketing site can be more theatrical, but still deliberate
- **Easing:**
  - enter: `cubic-bezier(0.18, 0.89, 0.32, 1.1)`
  - exit: `cubic-bezier(0.55, 0, 0.55, 0.2)`
  - move: `cubic-bezier(0.2, 0.8, 0.2, 1)`
- **Duration:**
  - micro: `80-120ms`
  - short: `160-220ms`
  - medium: `260-360ms`
  - long: `420-560ms`

## Component Language
- **Marketing hero:** editorial headline + product stage + proof metrics. Never a generic center-stacked AI hero.
- **Trust disclosures:** render as visible inline bands or bordered callouts, not footer afterthoughts.
- **Dashboard shell:** fixed workspace rail, sticky search/action bar, clear page header, compact metrics, then task surfaces. Navigation follows product objects, not implementation packages.
- **Cards:** white or lightly tinted surfaces, thin gray rules, subtle shadows, and `12-16px` radii. Teal/indigo tint is semantic, never decorative wallpaper.
- **Tabs and steppers:** should read like operational routing, with clear sequence and state.
- **Chips:** use as status and scope indicators, not decoration spam.
- **Tables and traces:** use mono for values, but keep surrounding UI human-readable.
- **Metric cards:** pair one operational label, one mono value, and one short interpretation. Avoid unlabeled vanity statistics.
- **Framework state:** unfinished business actions must be visibly labeled as preview/framework state; sample data must not masquerade as live production truth.

## Do Not Do
- No purple-first AI palette
- No dark-glass default aesthetic
- No icon-in-colored-circle feature grid as the main marketing pattern
- No "friendly assistant" illustrations that collapse the trust boundary story
- No uniform giant radii on every element
- No empty futuristic gradients without product context
- No returning to warm parchment/copper as the main Dashboard palette; Dashboard and Site now share the teal/indigo light system.
- No single mega-page that mixes approvals, compute sessions, artifacts, deliverables, policy, and billing without an information-architecture boundary.

## Implementation Notes
- Split the product into three visual modes that still share one system:
  - **Website:** editorial, persuasive, future-facing
  - **Public representative page:** trust-first, boundary-first, lightly procedural
  - **Owner dashboard:** operational, dense, navigable
- Reuse the same palette and typography across all three, but shift density and layout.
- Use teal as the default "trusted/live system" color and indigo for decisions, automation, and secondary emphasis.
- Dashboard v2 top-level information architecture is fixed to: Overview, Knowledge Library, Digital Representatives, Inbox, Approvals, Skills, Wallet, Memory, Analytics, Channels, Audit Logs, and Settings.
- Representative-specific identity, knowledge bindings, FAQ, service scope, safety boundaries, pricing, publishing, and runtime data live under Digital Representatives rather than becoming top-level dashboard tabs.
- General compute is exposed through Approvals and Skills/MCP surfaces; artifacts and deliverables attach to the business object that produced them instead of becoming a single oversized control-plane page.

## Knowledge Library Pattern
- **Object model:** Knowledge is a workspace asset first and a representative binding second. A file, URL, or authored text exists once, then receives explicit visibility and representative links.
- **Primary view:** Use a compact operational table with title/source, type and tags, processing status, visibility, linked representatives, updated time, and a clear detail affordance.
- **Summary strip:** Show current assets, ready, processing, failed, and linked counts. Teal means ready/trusted, indigo means in-process automation, and red is reserved for actionable failure.
- **Import flow:** Keep file, public URL, and manual text in one focused modal. File intake supports up to 20 files per batch, a compact queue with aggregate and per-file progress, upload retry, processing retry, and an explicit duplicate policy. Visibility is required at import time; selected-representative scope must not save without an enabled representative.
- **Duplicate semantics:** Default to skipping byte-identical content while preserving same-name/different-content files as numbered copies. Offer deliberate “keep both” and “replace existing” modes; replacement retains the existing asset identity, access rules, tags, and representative links while rebuilding derived content and the vector index.
- **Details:** Use a right-side drawer with Overview, Extracted text, Access & representatives, and Processing logs. Summary and permission context appear before raw extracted content.
- **Tags:** Hand-authored tags use teal-soft chips; generated tags use indigo-soft chips with a generated marker. Tags clarify retrieval scope and must not become decoration.
- **Processing feedback:** Every asset exposes ready/processing/failed/archived status, a processing version, last processed time, and an ordered log. Failed processing always includes a visible retry action.
- **Destructive actions:** Archive is reversible and is the default removal action. Permanent deletion is available only after archiving and requires confirmation.
- **Responsive behavior:** Metrics collapse from five to three to two columns. Filters become a single column on mobile; the data table remains horizontally scrollable instead of hiding permission or status fields. Import becomes a full-screen sheet and details become a full-width drawer.
- **Accessibility:** Modal and drawer backgrounds are inert, focus enters the active surface, Escape closes it, controls keep visible labels, and semantic status is expressed with text in addition to color.

## Digital Representatives Pattern
- **Primary hierarchy:** Lead with the active representative identity, lifecycle state, and immutable published version. Configuration is subordinate to operational readiness rather than presented as one unbounded form.
- **Workspace flow:** Keep three persistent module-level destinations: representative directory and creation, six-step configuration, and publish/operate. Creation opens the new representative's configuration immediately; one Owner may create multiple independently configured representatives.
- **Draft/public boundary:** Configuration saves update the working draft only. Public profiles, test chat, channel delivery, and asynchronous generation resolve the active published version; public-entry actions stay disabled until a first version exists.
- **Readiness:** Identity, knowledge, human handoff, pricing, and channel readiness are explicit checklist rows. A publish action remains disabled until every required row is complete, and server validation must match the visual checklist.
- **Representative knowledge:** Keep authored `Identity / FAQ / Materials / Policies` separate from workspace knowledge assets. The Knowledge step exposes an inline searchable multi-selector for ready, non-archived assets, keeps selected files visible after the selector collapses, and states that selection grants representative retrieval access without duplicating the source.
- **Knowledge binding feedback:** Count linked workspace assets alongside authored entries. Binding saves return immediately and queue representative-scoped indexing in the background; unavailable assets remain visible with textual processing state but cannot be newly selected.
- **Configuration feedback:** Save and sync results use a viewport-fixed notification banner so feedback remains visible from long forms. Success notices dismiss automatically after a short interval and remain manually dismissible; actionable errors persist until dismissed.
- **Version language:** Published versions use compact mono labels such as `v3`. The active version uses teal-safe treatment; historical versions stay neutral and expose a deliberate reactivate action.
- **Channels:** Web, Matrix, and Telegram appear as operational bindings with textual health states and external identity. Channel colors may distinguish transport, but status cannot rely on color alone.
- **Trust boundary:** Runtime safety, permission revocation, channel pause, and knowledge withdrawal are real-time policy overlays, not editable historical version fields.
- **Responsive behavior:** Identity and status stack on narrow screens; readiness rows preserve their description and action; configuration groups become one column.

## Unified Inbox Pattern
- **Object navigation:** The module uses three persistent views — Conversations, Pending, and Leads. A Contact is identity, a Pending item is work, and a Lead is an opportunity; do not collapse them into one ambiguous row type.
- **Three-pane desktop layout:** Conversation queue, message timeline, and contact/run inspector. The inspector may collapse below 1180px; the queue stacks above the thread below 880px.
- **Queue density:** Each row contains contact, last message, time, channel, episode state, paid marker, and unread count. Search and operational state filters stay directly above the queue.
- **Message authorship:** Audience, digital representative, operator, system, and tool messages must be visually and textually distinct. Human operator messages never masquerade as the representative.
- **Control state:** The thread header always states whether AI or a named human controls the conversation. Human takeover and return-to-AI are explicit audited actions.
- **Context strip:** Episode number, pinned representative version, payment state, and current controller stay visible above the timeline.
- **Knowledge provenance:** Public-safe citation titles and excerpts sit under the relevant representative message. Internal prompts, credentials, and hidden chain-of-thought never appear.
- **Empty and failure states:** An empty queue, filtered-empty queue, failed generation, and disconnected channel each provide a recovery action and enough vertical space to remain legible.
- **Composer:** Human reply is an inline composer, enabled only while a named Operator owns the conversation. Internal notes use a separate team-only input in the inspector.
- **Realtime:** Queue changes arrive without a page reload. Realtime state must preserve the current selection and must not erase unsent operator text.

## Wallet & Billing Pattern
- **Scope:** Wallet is a workspace money view first. It opens on all owned representatives and narrows by representative, currency, date, and event type without changing the active representative used to authorize the Dashboard session.
- **Currency boundary:** Every metric and table request resolves exactly one currency. Never add unlike currencies or present a converted total unless an explicit exchange-rate product is introduced later.
- **Primary hierarchy:** Lead with period gross sales and released creator income, then current pending earnings, withdrawable earnings, and payout-in-progress funds. Every value pairs a mono amount with a short operational interpretation.
- **Navigation:** Keep four persistent destinations: Overview, Transactions, Settlements, and Ledger. Transactions are human-readable business events; Ledger is the immutable movement trail and must not become the default owner experience.
- **Traceability:** Selecting a transaction, withdrawal, or ledger entry reveals its representative, status, time, source, transaction ID, and event group. Business events explain what happened; linked ledger entries prove how value moved.
- **Filters and time:** Representative, currency, date range, event type, and search stay directly above the current view. The server anchors listed records at an explicit `asOf` event cutoff and uses cursor pagination so appended events do not corrupt page boundaries. `asOf` is not a historical balance snapshot: current balance cards, period totals, actions, and filter facets are calculated with the first page and remain fixed while later event pages append.
- **Status language:** Use textual states in addition to color. Teal means completed/trusted, amber means pending review or processing, red means actionable failure, and neutral gray means canceled, refunded, or reversed.
- **Primary action:** Show withdrawal only when verified, withdrawable funds exist, and no incompatible payout state blocks it. Otherwise show the concrete prerequisite or no action; never render a decorative button that implies money will move.
- **Empty and framework states:** Live zero states say that no matching records exist. Sample values are never shown as production balances, and incomplete payout integrations remain explicitly labeled.
- **Responsive behavior:** Desktop uses a horizontally scrollable operational table with a trace detail rail. On mobile, preserve every financial column through horizontal scrolling and open details as a full-screen sheet with Escape, focus containment, visible close control, and at least 44px touch targets.
- **Security:** Wallet responses are owner- and billing-permission scoped, private, and non-cacheable. UI and exports contain normalized references only, never raw provider payloads, credentials, or internal exception text.

## Public Representative Chat-first Pattern
- **Audience:** The public representative page is for the external visitor, never the Owner operating the representative. Owner-facing counts, setup terminology, runtime configuration, channel roadmaps, and skill-pack internals remain in the Dashboard.
- **First task:** The primary public action is conversation. Use a compact identity hero followed immediately by the durable chat; do not require an extra “start” page or force visitors through representative configuration explanations.
- **Identity summary:** The first viewport answers who the representative serves, what kind of help it offers, whether replies are AI or human, which languages are available, and how to begin. Do not use knowledge-item, skill, or runtime counts as public proof metrics.
- **Conversation layout:** On desktop, use a dominant conversation column plus a compact session sidebar for current responder, remaining free use, human handoff, optional service depth, and privacy. On mobile, keep conversation first and stack the sidebar below it.
- **Task language:** Translate configured skills into visitor outcomes such as answering questions, organizing a request, preparing quote context, finding public resources, requesting a meeting, and asking for a human. Never expose activation modes, package sources, internal routing, or execution terminology.
- **Public-only language:** Do not expose Dashboard, control-plane, memory-console, source-code, or internal runtime links to ordinary visitors.
- **Durability:** Restore the server timeline on load. Submission shows an accepted/pending state, final content arrives asynchronously, and refreshing the page never discards persisted messages.
- **Authorship and handoff:** Digital representative and human Operator messages are visually and textually explicit. When human control is active, keep the composer available for additional context and show the queue state.
- **Citations:** Show public-safe source titles on the answer that used them; keep long excerpts collapsed by default. Never show internal URIs, prompts, credentials, hidden reasoning, or retrieval diagnostics.
- **Availability:** Published version, public mode, Web channel, and pause state use one server gate across page and APIs. A paused representative receives a focused offline state, not a partially functional marketing page.
- **Commercial UI:** Service plans are secondary and contextual. Keep them collapsed while free replies remain, reveal them when the visitor asks or reaches the limit, and never duplicate the full pricing grid elsewhere on the page. Mock recharge, fake QR, roadmap channels, and demo trust claims are development-only and hidden from production.
- **Trust disclosure:** Explain AI authorship, public knowledge use, privacy limits, and human-confirmation requirements in concise visitor language. Detailed policies may expand from a compact trust section rather than occupying the primary task flow.
- **Public resources:** Show only actual visitor-ready FAQs, materials, policies, and deliverables. Hide empty categories and zero-count operational states; knowledge provenance belongs primarily on the answer that used it.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-24 | Initial design system created | Created by `/design-consultation` after reviewing Delegate's product positioning and researching Linear, Vercel, LangSmith, Intercom, and beehiiv. |
| 2026-03-24 | Chosen direction: Dispatch Editorial | Delegate is selling public representation, trust boundaries, and paid access, not generic AI intelligence. |
| 2026-06-29 | Synchronized Site, Dashboard, and Reps surfaces | Tightened the shared Dispatch Editorial system across the marketing site, owner dashboard, and public representative page; improved mobile hierarchy, surface contrast, and trust/action signal rhythm. |
| 2026-07-02 | Aligned pages to web-first AI front desk framing | README now positions Delegate as the first web AI reception layer before future Telegram, WhatsApp, Feishu, and WeCom channels; pages should make the receive, charge, approve, and handoff sequence visible. |
| 2026-07-15 | Reframed Dashboard as workspace-level Digital Representative OS | Replaced the representative-centric seven-tab dashboard with a 12-module workspace information architecture; synchronized Dashboard colors, typography, borders, and surface language with the current light teal/indigo Site implementation. |
| 2026-07-15 | Defined the workspace Knowledge Library interaction pattern | Established file/URL/text intake, operational status language, explicit visibility and representative bindings, traceable processing details, archive-before-delete safety, and responsive/accessibility behavior as the source of truth for knowledge UI. |
| 2026-07-16 | Added batch file intake and deterministic duplicate handling | Keeps multi-file work visible and recoverable with queue progress and retry, prevents accidental duplicate storage by default, and makes destructive replacement an explicit user choice. |
| 2026-07-16 | Defined Digital Representative operations and the unified Inbox | Makes publish readiness, immutable versions, explicit AI/human control, citations, and channel state part of the core trust-first dashboard system. |
| 2026-07-17 | Restored the Owner 1:N representative workspace flow | Makes creation, six-step draft configuration, publish readiness, immutable public runtime, and version reactivation reachable in one module without changing Owner identity from representative settings. |
| 2026-07-17 | Connected representative setup to the workspace Knowledge Library | Keeps structured public answers and reusable source assets distinct while allowing ready files to be authorized, counted, and indexed for a representative without duplicate storage. |
| 2026-07-17 | Defined Conversations / Pending / Leads and Chat-first public runtime | Separates identity, work, and opportunity state; makes operator authorship, durable async chat, public citations, and one strict availability gate part of the product contract. |
| 2026-07-23 | Defined workspace Wallet & Billing | Separates explainable money events from immutable ledger movements, enforces single-currency totals, makes payout prerequisites explicit, and establishes traceable desktop/mobile behavior for owner financial operations. |
