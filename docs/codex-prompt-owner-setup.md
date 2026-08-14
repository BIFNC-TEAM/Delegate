# Codex Prompt: Owner Setup + DB-backed Representative Runtime

You are working in `/Users/a/repos/Delegate`.

Build the next highest-leverage slice of Delegate:

## Objective

Convert the project from a hardcoded founder-representative demo into a real owner-configurable Telegram representative system.

## Product goal

An owner should be able to open the dashboard, edit the representative's public profile, knowledge pack, pricing contract, and handoff copy, and have both:

- the public representative page
- the Telegram bot runtime

use the persisted configuration instead of demo-only defaults.

## Scope

Implement the following end to end:

1. Dashboard setup editor
- representative basics: display name, owner name, tagline, tone, languages, group activation, public / human-in-loop toggles
- pricing and handoff: free reply limit, service products, handoff prompt, and review window
- handoff prompt
- pricing plans for `Free / Pass / Deep Help / Sponsor`
- knowledge pack editing for identity summary, FAQ, materials, and policies

2. Persistence layer
- create server helpers and API routes for reading and updating representative setup from Prisma
- preserve demo fallback behavior only when Prisma is unavailable and slug is the demo representative

3. Public page integration
- `/reps/[slug]` must read the persisted representative instead of importing only `demoRepresentative`
- keep existing trust-interface layout, but populate it from DB

4. Bot runtime integration
- bot `/start`, `/plans`, paywall checks, reply copy, free limits, handoff wording, and pricing should use the persisted representative config when available
- keep a safe fallback to the demo representative if DB is unavailable

## Constraints

- keep the product Telegram-only
- do not add private-memory or arbitrary tool access
- do not add multi-channel abstractions
- do not revert any existing user-facing behavior unless needed to make persisted config authoritative
- use `apply_patch` for manual file edits
- keep ASCII unless the file already uses non-ASCII

## Important repo context

- representative domain schema: `packages/domain/src/schema.ts`
- demo representative: `packages/domain/src/demo.ts`
- public page: `apps/web/app/reps/[slug]/page.tsx`
- dashboard: `apps/web/app/dashboard/page.tsx`
- dashboard skill pack data pattern: `apps/web/lib/representative-skill-packs.ts`
- owner dashboard data pattern: `apps/web/lib/owner-dashboard.ts`
- bot runtime: `apps/bot/src/index.ts`
- bot persistence: `apps/bot/src/runtime-store.ts`
- Prisma schema + seed: `prisma/schema.prisma`, `prisma/seed.ts`

## Expected implementation shape

- create a shared web data module for representative setup snapshots and updates
- add a dashboard setup component and API route(s)
- update the public page to use the persisted snapshot
- update the bot runtime to hydrate a domain `Representative` from DB before planning replies

## Acceptance criteria

- dashboard shows an editable setup section for the representative
- saving setup persists to Postgres
- public representative page reflects saved setup data after refresh
- bot response header, free rule, and pricing data come from persisted config
- `pnpm typecheck`, `pnpm test`, `pnpm build`, and Docker stack startup still pass

## Verification

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm docker:up
pnpm docker:ps
```

If possible, also verify:

- update representative setup through the dashboard
- refresh `/reps/[slug]` and confirm changes appear
- inspect bot startup logs to confirm DB-backed representative config loaded
