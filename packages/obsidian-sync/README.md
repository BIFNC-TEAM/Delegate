# Obsidian Sync read adapter

This server-only package reuses `obsidian-headless@0.0.14`. The committed pnpm
patch exports a narrow interface and suppresses CLI execution when imported.
It does not run the stock synchronizer, write local vault files, or change the
encryption algorithm. Node.js 22 or newer is required.

## Boundaries

- `src/index.ts` is the only code that accesses the patched upstream exports.
- `packages/web-data/src/obsidian-sync` owns database state and credential encryption.
- `apps/web/app/api/dashboard/obsidian-sync` authenticates the owner and validates requests.
- `knowledge-obsidian-sync.tsx` selects remote notes; `knowledge-obsidian-import.tsx`
  prepares them using the existing local-import naming, reference and queue rules.
- The account and each vault key are retained in an authenticated, encrypted database
  envelope bound to the owner and connection ID. Account and vault passwords are not stored.
- Each connection expires seven days after login, without sliding renewal. Expired
  credentials are rejected immediately. Dashboard instrumentation removes expired
  rows every minute while the server runs, and on startup. Disconnect deletes the
  envelope before attempting remote logout.
- A separate, short-lived read-only WebSocket is used per listing/download operation.
  Metadata listing never calls `pull`. Downloads accept only selected IDs found in a
  fresh note listing; stale selections fail instead of silently fetching replacements.
  References never trigger a download. No account-global CLI credential files are used.
- Allowlisted wire operations are `init`, `ping`, and `pull`; binary uploads are blocked.

## Configuration and rollout

Set `OBSIDIAN_SYNC_CREDENTIAL_KEY` to a base64-encoded cryptographically random
32-byte key. All dashboard instances must use the same key. There is no default
production key. Changing it makes existing connection ciphertext unreadable.
Do not commit actual keys or any Obsidian credentials.

Apply the Prisma migration and regenerate the client before starting the new dashboard:

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:deploy
```

For a local Next.js development server, set the key in `apps/web/.env.local`.
For Compose, set the variable in the deployment environment (or its ignored `.env`).
The Compose dashboard receives it through the shared application environment.
Rebuild the application image for Docker deployments: this change adds a package
and a dependency patch, so restarting an old container alone is insufficient.

## Upgrade procedure

1. Review upstream changes and select an exact version. Do not use an automatic range.
2. Recreate the small export/entrypoint patch with pnpm's patch workflow.
3. Run typechecks and the adapter, credential, service, route and local-import tests.
4. Verify both standard and end-to-end encrypted test vaults against the real service:
   metadata listing must receive no bodies; one selected note must produce one pull;
   referenced and unselected notes must not be downloaded; writes must remain blocked.
5. Verify a production dashboard build and existing CLI `--version` still work.

Patch application succeeding is not evidence of protocol compatibility. A changed
protocol must fail visibly; never fall back to full-vault synchronization. If upstream
offers a supported selective API, replace this adapter and remove the patch while
preserving the service interface.

The integration uses internal Headless capabilities under the project owner's
reported permission from Obsidian. It is not presented as a public Obsidian SDK.
