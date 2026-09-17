# Registered username and historical Owner name repair

## Scope and field ownership

Registration is hosted by Logto. The application requests the `profile` scope,
verifies the callback ID token, and chooses the initial display-name candidate
from non-empty `name`, `username`, then `preferred_username`. Existing email,
phone and `Creator <subject-prefix>` fallbacks remain available when no name is
returned. Identity matching always uses provider, issuer and subject, never a
name or email.

- `Owner.displayName`: public Owner attribution and the default account label.
- `Owner.accountDisplayName`: the independently chosen account nickname. Site and
  Dashboard account labels prefer it over `Owner.displayName`.
- `Delegate Studio`: the current workspace label, unrelated to these fields.
- Representative names and published version snapshots are separate data.

Login automatically repairs only an exact subject-derived placeholder on an
untouched Owner. An Account/AppSession binding also changes `Owner.updatedAt`,
so updated historical rows require a reviewed repair. Do not remove the
untouched-row guard: the database has no complete provenance distinguishing
past user renames from other updates.

## Preview a specific historical account

Confirm the test deployment/database and exact Logto user first. Check the
registered username or desired Owner attribution with that user; names are not
identity keys. Create a private target JSON outside the repository:

```json
{
  "ownerId": "the-confirmed-owner-id",
  "issuer": "https://the-confirmed-auth-host/oidc",
  "subject": "the-confirmed-logto-user-id",
  "displayName": "the-confirmed-correct-name"
}
```

From the repository root, load the explicitly selected test environment:

```sh
node --env-file=/secure/delegate-test.env --import tsx scripts/repair-owner-name.ts preview /secure/target.json /secure/owner-name-plan.json
```

This command is read-only against the database. It refuses non-placeholder Owner
names and requires an exact Owner ID + issuer + subject match. It creates a new
plan file with mode `0600` and refuses to overwrite an existing file. The plan
contains the proposed name and current fields, including any chosen nickname;
keep it private and out of Git. It contains no database credentials.

Review the proposed name, account nickname, identity tuple and database target.
The tool always preserves `accountDisplayName`, including when it happens to look
like a generated name. If the user wants to change that nickname, use the normal
account Settings save flow as a separate explicit user choice.

## Apply the reviewed plan

```sh
node --env-file=/secure/delegate-test.env --import tsx scripts/repair-owner-name.ts apply /secure/owner-name-plan.json
```

Apply binds the plan to its database host, port, database name and schema. It
checks the identity tuple and exact snapshot again. It updates only
`Owner.displayName` and increments `settingsVersion`; all existing sessions,
account links, nicknames, workspace labels and representative/version data stay
unchanged. A settings audit records the repair ID, changed field and versions,
without storing name history.

Any intervening nickname save, Owner rename, account reassignment or timestamp
change rejects the stale plan. Produce and review a new preview; never edit its
expected snapshot to bypass the conflict. Audit failure rolls the update back.
Concurrent transaction conflicts are reported as failures; retrying the same
completed plan returns `already_applied` without another write. Reusing its ID
with a different payload is rejected.

Refresh the Site and Dashboard to check the account label and Owner attribution.
A custom account nickname can intentionally differ from the Owner name. This
procedure does not republish historical representative snapshots.

## Verification

```sh
pnpm exec vitest run packages/web-data/tests/owner-name-repair.test.ts packages/web-data/tests/auth-session.test.ts packages/web-data/tests/auth-identities.test.ts
pnpm test:postgres:owner-settings
pnpm --filter @delegate/web-data typecheck
pnpm exec turbo run test --concurrency=1
```

The PostgreSQL gate provisions a disposable local database. It covers actual
Account/AppSession attachment, the remaining login-time placeholder, reviewed
repair with and without a custom nickname, idempotent retry, stale preview
rejection and rollback when audit persistence fails. It does not access a
shared testing or production deployment.
