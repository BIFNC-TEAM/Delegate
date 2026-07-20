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
7. Recharge uses the same cookie-derived audience identity and writes `UserWallet.audienceIdentityId`.
8. Logto login links `IdentityLink(provider=LOGTO)` to the current `AudienceIdentity`.
9. If the Logto subject already belongs to another audience identity, the current anonymous identity is merged into the registered target.
10. Later cookie reuse of a merged anonymous identity resolves to the target identity, so contacts, wallets, memory, and sandbox identity do not regress.
11. Payment external ids are linked through `IdentityLink(provider=PAYMENT_EXTERNAL_USER)`.
12. Public compute session creation uses the same `contactId` and `conversationId`.
13. Compute broker creates or reuses `SandboxIdentity` from `representativeId + contactId` and copies `Contact.audienceIdentityId`.

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

If the original anonymous cookie is used again after merge, `resolveAnonymousAudienceIdentity` returns the merge target and refreshes `lastSeenAt`. This prevents later chat, recharge, or computer-use requests from reattaching state to the merged source identity.

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
./node_modules/.bin/vitest run apps/reps/tests/public-chat-identity.test.ts apps/reps/tests/public-web-compute.test.ts
./node_modules/.bin/vitest run packages/web-data/tests/web-audience.test.ts packages/web-data/tests/agent-wallet-recharge.test.ts
./node_modules/.bin/vitest run packages/web-data/tests/auth-identities.test.ts packages/web-data/tests/auth-session.test.ts packages/web-data/tests/owner-access.test.ts
./node_modules/.bin/vitest run apps/web/tests/auth-guard.test.ts
./node_modules/.bin/vitest run apps/compute-broker/tests/sandbox-leases.test.ts apps/compute-broker/tests/compute-session-sandbox-path.test.ts apps/compute-broker/tests/sandbox-schema.test.ts
./node_modules/.bin/tsc --noEmit -p apps/reps/tsconfig.json
./node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json
./node_modules/.bin/tsc --noEmit -p packages/web-data/tsconfig.json
./node_modules/.bin/tsc --noEmit -p apps/compute-broker/tsconfig.json
DATABASE_URL='postgresql://delegate:delegate@localhost:5432/delegate' ./node_modules/.bin/prisma validate --schema prisma/schema.prisma
```
