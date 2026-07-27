# Public Audience Identity

Delegate public reps now use a channel-neutral audience identity path for web visitors.

The short-term web path is still backward-compatible with the existing Telegram-shaped fields, but new code should treat `AudienceIdentity` and `Contact.id` as the stable identity anchors.

## Runtime Flow

1. First web visit creates a signed, httpOnly cookie scoped to `/reps/{slug}`.
2. The cookie stores only `audienceId`, `sessionToken`, and `expiresAt`.
3. Server code resolves `AudienceIdentity` from `web:{audienceId}`.
4. Server code resolves one `Contact` per representative and audience.
5. Server code resolves one `Conversation` per representative, contact, and web audience thread.
6. Chat writes the channel-neutral `Message` / `GenerationRun` path, returns `202 Accepted`, and completes asynchronously in the conversation worker; history and recent context come from Postgres, never from cookies.
7. Anonymous cookies support conversation continuity and the pre-login merge only. Recharge creation, payment completion, and reversal require a verified Web login; the server revalidates the canonical Logto principal, writes `UserWallet.audienceIdentityId`, and persists the immutable representative/product purchase intent on the recharge order.
8. Logto login links `IdentityLink(provider=LOGTO)` to the current `AudienceIdentity`.
9. If the Logto subject already belongs to another audience identity, the current anonymous identity is merged into the registered target.
10. Every authenticated business request revalidates the signed session against the current verified, unrevoked Logto link and its canonical identity.
11. The canonical identity owns all linked state, while each signed browser keeps its existing `web:{audienceId}` conversation thread so pre-login history and artifacts remain reachable.
12. Reuse of a merged anonymous cookie without its valid authenticated session rotates to a fresh anonymous identity instead of inheriting registered state.
13. Wallet lookup prefers the one CNY wallet attached to the canonical identity; multiple wallets fail closed for reconciliation.
14. Payment external ids are linked through `IdentityLink(provider=PAYMENT_EXTERNAL_USER)`.
15. Public compute session creation uses the canonical identity and the active browser's `contactId` and `conversationId`.
16. Compute broker creates or reuses `SandboxIdentity` from `representativeId + contactId` and copies `Contact.audienceIdentityId`.
17. Paid wallet purchase, usage, and reversal update both the scoped wallet and canonical `ServiceEntitlement` in one Serializable transaction.
18. Wallet balance reads use one Serializable snapshot and paid authorization requires wallet/entitlement parity; drift returns reconciliation-required and never queues paid work.
19. Audience Compute requires an active owned `GenerationRun` with a server-persisted free slot, an exact dual-ledger wallet reservation, or an active plan reservation. Legacy unlock fields and client entitlement flags are ignored.
20. Dual-ledger reservation canonicalizes both the requested audience and the wallet owner before writing. The package root exposes only the composite reserve/settle/release lifecycle; wallet-only mutation primitives remain internal.

## Public Runtime Gate

Every visitor-facing page and API uses `getPublicRepresentativeRuntime` before accessing representative data. Availability requires all of the following:

- lifecycle is `PUBLISHED`;
- an immutable active version exists;
- `publicMode` is enabled;
- the Web channel binding is `CONNECTED`;
- lifecycle is not `PAUSED`.

The page renders a dedicated paused state. Chat, SSE, login, callback, compute, recharge, mock recharge confirmation, and public deliverable downloads return the same unavailable state instead of leaking draft/runtime differences between routes.

The representative page is Chat-first. It restores the current audience timeline through `GET /reps/{slug}/chat`, submits through `POST /reps/{slug}/chat`, and receives the final persisted message through `/chat/runs/{runId}/events`. Public messages expose only safe citation title, excerpt, and URI fields.

## Compatibility Fields

Current web code dual-writes:

- `Contact.telegramUserId = web:{audienceId}`
- `Contact.channelUserId = web:{audienceId}`
- `Contact.source = web`
- `Contact.sourceChannel = web`
- `Conversation.telegramChatId = web:{audienceId}`
- `Conversation.channelThreadId = web:{audienceId}`
- `Conversation.sourceChannel = web`
- `Message.clientMessageId = <browser generated UUID>`
- `Message.senderType = AUDIENCE | REPRESENTATIVE`
- `GenerationRun.idempotencyKey = reply:{conversationId}:{clientMessageId}`

Each long-lived web `Conversation` creates version-pinned `ConversationEpisode` records as service periods resolve and reopen. A human-controlled episode accepts inbound messages but does not queue an AI generation run.

The Telegram-shaped fields remain because existing unique indexes and older code still depend on them. New code should prefer `audienceIdentityId`, `channelUserId`, and `channelThreadId` when possible.

## Login And Merge Semantics

The short-term identity rule is:

- anonymous web identity starts from the signed public-chat cookie
- logged-in identity is attached through `IdentityLink(provider=LOGTO)`
- recharge identity is attached through `IdentityLink(provider=PAYMENT_EXTERNAL_USER)`
- business state hangs from `Contact.id` and `AudienceIdentity.id`

When a visitor logs in after using the public web chat, Delegate moves source references into the registered target identity:

- `Contact.audienceIdentityId`
- `Conversation.audienceIdentityId`
- `UserWallet.audienceIdentityId`
- `SandboxIdentity.audienceIdentityId`
- `OpenVikingMemoryRecord.audienceIdentityId`
- `IdentityLink.audienceIdentityId`

Authenticated Chat, SSE, artifact, Compute, recharge, mock-payment confirmation,
and unused-credit reversal requests resolve a server-authoritative public
principal. They verify that:

- the signed auth session still points to a verified, unrevoked Logto link;
- the session identity, Logto link target, and device Web identity share one
  canonical registered identity;
- accessed contacts, conversations, runs, artifacts, orders, and wallets belong
  to that identity and the signed browser's Web thread;
- long-lived SSE streams revalidate the captured authenticated session at least
  every two seconds and close when the link is revoked or the session expires;
- mock recharge completion matches the order's immutable representative and
  product intent before any payment or token purchase is finalized.

If the original anonymous cookie is later presented without its matching valid
auth session, it is rotated to a fresh anonymous identity. Revoked links and
ambiguous same-currency wallets fail closed rather than silently restoring,
merging, or selecting financial state.

## Creator Dashboard Login

The creator dashboard uses Logto-compatible OIDC:

- `/auth/login` creates signed callback state and redirects to Logto.
- `/auth/callback` exchanges the code, resolves or creates `Owner`, and writes a signed `delegate_auth_session` cookie.
- `/auth/logout` clears auth cookies.
- production requires `DELEGATE_AUTH_SESSION_SECRET`; local development falls back to a dev-only secret.

Representative directory and creation APIs now scope to the logged-in `Owner`. The setup API checks that the current owner owns the requested representative before reading or writing setup state.

## Sandbox Semantics

Delegate still does not allocate one always-on VM for every public visitor.

The stable identity is:

- `AudienceIdentity`: cross-channel person or anonymous visitor.
- `Contact`: this audience identity in the context of one representative.
- `SandboxIdentity`: this representative/contact pair's persistent sandbox identity.

The runtime is on-demand:

- `ComputeSession` records a task attempt.
- `SandboxLease` starts or resumes the runtime only when computer-use is needed.
- idle cleanup can stop the runtime while preserving the sandbox identity.

## Verification

Useful focused checks:

```bash
./node_modules/.bin/vitest run apps/reps/tests/public-chat-identity.test.ts apps/reps/tests/public-web-compute.test.ts apps/reps/tests/public-recharge-security.test.ts
./node_modules/.bin/vitest run packages/web-data/tests/public-audience-principal.test.ts packages/web-data/tests/web-audience.test.ts packages/web-data/tests/agent-wallet-recharge.test.ts
./node_modules/.bin/vitest run packages/web-data/tests/auth-identities.test.ts packages/web-data/tests/auth-session.test.ts packages/web-data/tests/owner-access.test.ts
./node_modules/.bin/vitest run apps/web/tests/auth-guard.test.ts
./node_modules/.bin/vitest run apps/compute-broker/tests/sandbox-leases.test.ts apps/compute-broker/tests/compute-session-sandbox-path.test.ts apps/compute-broker/tests/sandbox-schema.test.ts
./node_modules/.bin/tsc --noEmit -p apps/reps/tsconfig.json
./node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json
./node_modules/.bin/tsc --noEmit -p packages/web-data/tsconfig.json
./node_modules/.bin/tsc --noEmit -p apps/compute-broker/tsconfig.json
DATABASE_URL='postgresql://delegate:delegate@localhost:5432/delegate' ./node_modules/.bin/prisma validate --schema prisma/schema.prisma
```
