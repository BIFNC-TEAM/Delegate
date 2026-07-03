# Public Audience Identity

Delegate public reps now use a channel-neutral audience identity path for web visitors.

The short-term web path is still backward-compatible with the existing Telegram-shaped fields, but new code should treat `AudienceIdentity` and `Contact.id` as the stable identity anchors.

## Runtime Flow

1. First web visit creates a signed, httpOnly cookie scoped to `/reps/{slug}`.
2. The cookie stores only `audienceId`, `sessionToken`, and `expiresAt`.
3. Server code resolves `AudienceIdentity` from `web:{audienceId}`.
4. Server code resolves one `Contact` per representative and audience.
5. Server code resolves one `Conversation` per representative, contact, and web audience thread.
6. Chat turns are persisted in `ConversationTurn`; recent model context is loaded from Postgres, not from cookies.
7. Recharge uses the same cookie-derived audience identity and writes `UserWallet.audienceIdentityId`.
8. Public compute session creation uses the same `contactId` and `conversationId`.
9. Compute broker creates or reuses `SandboxIdentity` from `representativeId + contactId` and copies `Contact.audienceIdentityId`.
10. Login, payment, Telegram, email, and phone links can attach to the same identity through `IdentityLink`; merge flows can move references to a target identity.

## Compatibility Fields

Current web code dual-writes:

- `Contact.telegramUserId = web:{audienceId}`
- `Contact.channelUserId = web:{audienceId}`
- `Contact.source = web`
- `Contact.sourceChannel = web`
- `Conversation.telegramChatId = web:{audienceId}`
- `Conversation.channelThreadId = web:{audienceId}`
- `Conversation.sourceChannel = web`

The Telegram-shaped fields remain because existing unique indexes and older code still depend on them. New code should prefer `audienceIdentityId`, `channelUserId`, and `channelThreadId` when possible.

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
./node_modules/.bin/vitest run apps/compute-broker/tests/sandbox-leases.test.ts apps/compute-broker/tests/compute-session-sandbox-path.test.ts apps/compute-broker/tests/sandbox-schema.test.ts
./node_modules/.bin/tsc --noEmit -p apps/reps/tsconfig.json
./node_modules/.bin/tsc --noEmit -p packages/web-data/tsconfig.json
./node_modules/.bin/tsc --noEmit -p apps/compute-broker/tsconfig.json
DATABASE_URL='postgresql://delegate:delegate@localhost:5432/delegate' ./node_modules/.bin/prisma validate --schema prisma/schema.prisma
```
