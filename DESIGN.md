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
- **Mood:** Public, composed, and legible. It should feel like an editorial front door fused with an operations desk: less "AI lab", more "trusted delegation office for the network era".
- **Reference sites:** [Linear](https://linear.app), [Vercel](https://vercel.com), [LangSmith](https://www.langchain.com/langsmith), [Intercom](https://www.intercom.com), [beehiiv](https://www.beehiiv.com)

## Safe Choices
- Use a disciplined dashboard grid, strong status chips, and clear table/card hierarchy. Operator products need scanability before personality.
- Keep trust disclosures explicit and visually close to primary actions. Delegate wins when boundaries are legible.
- Use high contrast typography and restrained surfaces so dense control-plane views stay usable.

## Risks Worth Taking
- Use a serif display face in a category dominated by generic sans-serif AI branding. This gives Delegate a public, representational identity instead of a commodity SaaS face.
- Use warm parchment neutrals with sea-ink and copper signals instead of black/purple/glass defaults. This makes the product feel civic, commercial, and memorable rather than interchangeable.
- Make the marketing site feel editorial and declarative, while the dashboard feels procedural and instrumented. The split is a feature, not an inconsistency.

## Typography
- **Display/Hero:** Instrument Serif — gives Delegate a public-facing voice with authority and personality. Best for hero headlines, section headers, and trust statements.
- **Body:** Instrument Sans — clean, contemporary, and readable without feeling as overused as Inter.
- **UI/Labels:** Instrument Sans — same as body, but with tighter tracking and stronger weight in controls.
- **Data/Tables:** IBM Plex Mono — use for numbers, IDs, timestamps, wallet values, and operational traces. It signals instrumentation and supports dense data presentation.
- **Code:** IBM Plex Mono
- **Loading:** Use project-local CSS font variables with resilient system fallbacks for builds. If the team wants exact Instrument/IBM rendering later, self-host the font files instead of relying on build-time Google Fonts fetches.
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
- **Approach:** Balanced
- **Primary:** `#1F5662` — sea-ink. Use for primary accents, trusted states, links, active dashboard tabs, and signal surfaces.
- **Secondary:** `#C55B2D` — copper signal. Use for primary CTA emphasis, highlights, pricing emphasis, and assertive attention states.
- **Accent support:** `#C79A3B` — brass. Use sparingly for premium tiers, sponsorship, and milestone emphasis.
- **Neutrals:**
  - `#FFF9F1` — paper
  - `#F3EBDD` — parchment
  - `#DED2C1` — warm line
  - `#8C8173` — muted copy
  - `#433B34` — secondary ink
  - `#1A1714` — primary ink
- **Semantic:**
  - success `#2F725D`
  - warning `#D08A1B`
  - error `#B9482F`
  - info `#2F6D86`
- **Dark mode:** Keep surfaces warm-charcoal instead of blue-black.
  - base surfaces should move toward `#131110`, `#1C1815`, `#27211C`
  - reduce teal and copper saturation by roughly 10-15%
  - preserve parchment-toned text for warmth, not pure white

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable in marketing, compact-comfortable in dashboard
- **Scale:** 2xs(2) xs(4) sm(8) md(12) lg(16) xl(24) 2xl(32) 3xl(48) 4xl(64) 5xl(96)

## Layout
- **Approach:** Hybrid
- **Grid:**
  - marketing: 12 columns desktop, 8 tablet, 4 mobile
  - dashboard: fixed left rail (`280-320px`) + 12-column content stage
  - public representative page: 12-column structure with strong summary header and two-zone content split
- **Max content width:**
  - marketing: `1280px`
  - dashboard: `1440px`
  - reading/detail sections: `72ch` max for long copy
- **Border radius:**
  - xs: `8px`
  - sm: `14px`
  - md: `20px`
  - lg: `28px`
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
- **Cards:** warm surfaces, thin ruled borders, large radius only where the card is conceptually a "module". Avoid making every small component bubble-shaped.
- **Tabs and steppers:** should read like operational routing, with clear sequence and state.
- **Chips:** use as status and scope indicators, not decoration spam.
- **Tables and traces:** use mono for values, but keep surrounding UI human-readable.

## Do Not Do
- No purple-first AI palette
- No dark-glass default aesthetic
- No icon-in-colored-circle feature grid as the main marketing pattern
- No "friendly assistant" illustrations that collapse the trust boundary story
- No uniform giant radii on every element
- No empty futuristic gradients without product context

## Implementation Notes
- Split the product into three visual modes that still share one system:
  - **Website:** editorial, persuasive, future-facing
  - **Public representative page:** trust-first, boundary-first, lightly procedural
  - **Owner dashboard:** operational, dense, navigable
- Reuse the same palette and typography across all three, but shift density and layout.
- Use copper sparingly so it remains a signal, not wallpaper.
- Use teal as the default "trusted system" color.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-24 | Initial design system created | Created by `/design-consultation` after reviewing Delegate's product positioning and researching Linear, Vercel, LangSmith, Intercom, and beehiiv. |
| 2026-03-24 | Chosen direction: Dispatch Editorial | Delegate is selling public representation, trust boundaries, and paid access, not generic AI intelligence. |
| 2026-06-29 | Synchronized Site, Dashboard, and Reps surfaces | Tightened the shared Dispatch Editorial system across the marketing site, owner dashboard, and public representative page; improved mobile hierarchy, surface contrast, and trust/action signal rhythm. |
| 2026-07-02 | Aligned pages to web-first AI front desk framing | README now positions Delegate as the first web AI reception layer before future Telegram, WhatsApp, Feishu, and WeCom channels; pages should make the receive, charge, approve, and handoff sequence visible. |
