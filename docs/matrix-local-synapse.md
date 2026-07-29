# Local Matrix / Synapse test environment

## Decision

A local Matrix homeserver is **not required** for normal Web or Telegram
development, or for the credential-free channel test suite. It **is required**
for a deterministic end-to-end Matrix release gate when no managed test
homeserver is available. Unit tests cannot prove the Application Service
registration, virtual-user impersonation, room membership, plaintext-room
state, or real Client API behavior.

The local gate therefore uses a disposable, non-federated Synapse instance.
It is development-only and must not be used as a production configuration.
Synapse is pinned to `matrixdotorg/synapse:v1.157.0`.

## Two isolated local instances

Run:

```bash
pnpm matrix:local:init
```

This initializes the normal full-application instance under `.local/matrix/`.
The deterministic release gate initializes a second instance automatically
under `.local/matrix-e2e/` when `pnpm matrix:local:e2e` runs. Both directories
are ignored by Git. Each instance has its own:

- `synapse/homeserver.yaml`, signing key, SQLite database, and media state;
- `synapse/delegate-appservice.yaml`;
- `matrix.env`, containing random AS/HS bearer tokens, a base64-encoded copy of
  the Synapse shared registration secret, and a random local test-user
  password.

The instances deliberately do not share a homeserver, Application Service
transaction stream, bearer token, bridge port, or Delegate database:

| Use | State | Server | Client API | Bridge | Delegate DB |
| --- | --- | --- | --- | --- | --- |
| Full local app | `.local/matrix/` | `matrix.local` | `127.0.0.1:8008` | `127.0.0.1:4030` | `delegate` |
| Automated gate | `.local/matrix-e2e/` | `matrix-e2e.local` | `127.0.0.1:8009` | `127.0.0.1:4031` | `delegate_matrix_e2e` |

The command is idempotent: subsequent runs reuse the same server name, host
port, connection ID, Synapse image, local identity, and tokens. Synapse's
`server_name` is immutable after initialization; bootstrap fails clearly if an
environment override requests a different name from the existing
`homeserver.yaml`. Delete only the intended instance directory when you
intentionally want a fresh, disposable homeserver. No production credential is
read or written.

For an existing instance, `synapse/delegate-appservice.yaml` is the
authoritative Application Service identity. Bootstrap requires the complete
registration and `matrix.env` files to exist together, requires all three
immutable values to be present in `matrix.env`, and requires their connection
ID, AS token, and HS token to match exactly. A missing file, missing immutable
key, or disagreement fails closed; bootstrap never generates replacement
tokens, replaces a missing homeserver, or overwrites the existing registration.
This matters because Synapse does not hot-reload Application Service
registrations.

Optional bootstrap overrides are deliberately local-only:
`MATRIX_LOCAL_SERVER_NAME`, `MATRIX_LOCAL_HOST_PORT`,
`MATRIX_LOCAL_CONNECTION_ID`, `MATRIX_LOCAL_SYNAPSE_IMAGE`,
`MATRIX_LOCAL_AS_TOKEN`, `MATRIX_LOCAL_AS_HS_TOKEN`,
`MATRIX_LOCAL_UID`, `MATRIX_LOCAL_GID`, `MATRIX_LOCAL_TEST_USERNAME`, and
`MATRIX_LOCAL_TEST_PASSWORD`. The UID/GID defaults match the host user (or the
Synapse image's `991:991` account when bootstrap runs as root), so native Linux
bind mounts remain readable and writable by both bootstrap and Synapse.
Generic runtime variables such as `MATRIX_AS_TOKEN`, `MATRIX_AS_HS_TOKEN`, and
`MATRIX_SERVER_NAME` are ignored by bootstrap so an already-configured
production shell cannot silently copy its credentials into the local stack.
`MATRIX_LOCAL_CONNECTION_ID` is accepted only on first initialization. The
connection ID is also stored in Delegate channel rows, so changing it requires
an explicit data migration or reset in addition to recreating the selected
local Synapse state.

Generated values are strict shell-safe scalars. The helpers validate and parse
`matrix.env` through a key whitelist; they never execute it with `source`.

The normal Matrix Compose wrapper layers configuration explicitly: it gives
Docker Compose the repository `.env` first, then the generated
`.local/matrix/matrix.env`. This makes model-provider settings and credentials
from the repository `.env` available to the application services while the
generated local Matrix identity, endpoints, and bearer tokens take precedence
over any `MATRIX_*` values in `.env`. The repository `.env` is passed to Docker
Compose for parsing and is never sourced or executed by the wrapper. Generated
Matrix credentials are not printed; inspect only non-secret readiness state
when diagnosing the local stack.

## Start and test

Start only the isolated E2E Synapse, E2E database/migrations, and E2E Matrix
bridge:

```bash
pnpm matrix:local:up
```

Run the protocol smoke test:

```bash
pnpm matrix:local:smoke
```

The smoke test:

1. waits for Synapse and the Delegate bridge;
2. creates or verifies the generated local Matrix audience account;
3. proves the bridge rejects a missing HS token and accepts the generated one;
4. registers a namespaced `_delegate_` Application Service user and verifies
   AS impersonation with `whoami`;
5. sends and reads a real `m.room.message` through the Client API; and
6. confirms `m.room.encryption` is absent.

The same gate then exercises the Delegate business path against
`delegate_matrix_e2e`, a dedicated database created alongside (but separate
from) the normal `delegate` database. It also uses the dedicated
`matrix-e2e.local` Synapse and its own Application Service transaction stream,
so an automated run can never acknowledge events intended for the normal
local bridge. Each run safely reapplies migrations and the idempotent seed
without dropping, resetting, migrating, or seeding the normal database. It
uses the seeded `owner_lin_demo` / `lin-founder-rep` workspace and preserves
prior E2E evidence so repeat runs remain valid:

1. provisions the representative's managed MXID through the real data layer;
2. invites it from the ordinary Matrix test account;
3. waits for Synapse → bridge registration/join and persisted `ACTIVE` room
   validation;
4. sends a real one-time `!bind` command, verifies the Web identity merge, and
   proves the raw token was not persisted;
5. sends an audience message and checks both `ChannelEventInbox` and `Message`;
6. creates a Dashboard Operator message and proves the durable
   `operator.message.requested` outbox is claimed, delivered, and completed by
   the real conversation-worker path;
7. verifies the audience timeline plus managed-sender echo idempotency;
8. disconnects the representative channel, confirms existing room/message
   history remains, then proves new inbound events are terminally consumed
   without a business message or generation and outbound delivery is rejected;
9. re-provisions the same managed MXID without replacing its channel binding or
   virtual-user identity; and
10. proves real inbound, outbound, and managed-sender echo processing resume.

For a one-command fresh start plus smoke:

```bash
pnpm matrix:local:e2e
```

Useful commands:

```bash
pnpm matrix:local:logs
pnpm matrix:local:ps
pnpm matrix:local:down
```

`matrix:local:down` stops and removes both local Synapse/bridge instances and
the E2E helper containers. It does not run Compose `down`, stop the shared
PostgreSQL service, remove the project network, or delete either state
directory/database.

If you intentionally delete `.local/matrix-e2e/` to change its immutable
`server_name`, also reset only the isolated Matrix E2E database before the next
run:

```bash
pnpm matrix:local:reset-e2e-db
```

This command terminates users of and drops only `delegate_matrix_e2e`; it never
drops the normal `delegate` database. Token and connection-ID overrides are
accepted only on first initialization. To change them intentionally, first stop
the affected instance, then recreate only its selected runtime directory and
reset or migrate the matching Delegate database channel rows. For the E2E
instance, use `pnpm matrix:local:reset-e2e-db`; for the normal instance, migrate
or reset only the local `delegate` data after confirming it is disposable.
Never delete the runtime directory alone while retaining channel rows that
reference its old connection ID.

Normal full-application endpoints:

- Synapse Client API: `http://127.0.0.1:8008`
- Delegate Matrix bridge: `http://127.0.0.1:4030`

Both published ports are bound explicitly to host loopback. Docker Compose
v2.24.4 or newer is required because the Matrix overlay uses `!override` to
replace the base bridge port mapping rather than accidentally exposing it on
all host interfaces.

Automated-gate endpoints:

- Synapse Client API: `http://127.0.0.1:8009`
- Delegate Matrix bridge: `http://127.0.0.1:4031`

Generated audience credentials remain in the selected instance's
`matrix.env`. Do not paste either file into issues or commits.
To create another local account, pass only its localpart and provide the
password through the environment so it is not exposed in the process list:

```bash
MATRIX_LOCAL_USER_PASSWORD='replace-with-a-test-password' \
  node scripts/matrix-local-create-user.mjs another_user
```

The default generated test password is read from `matrix.env`; it is never
passed through command-line arguments. Set `MATRIX_LOCAL_INSTANCE=e2e` to
target the automated-gate instance.

## Full application flow

Use `pnpm docker:up:matrix` to start the normal local application stack plus
Synapse and the Matrix bridge. Then:

1. open the Dashboard Channels page and provision Matrix for a published
   representative;
2. note the managed MXID (for example
   `@_delegate_rep_lin_founder:matrix.local`);
3. log into a Matrix client against `http://127.0.0.1:8008` with the generated
   audience credentials;
4. create an **unencrypted** direct room and invite the managed MXID;
5. wait for the AS user to join and the room to become active;
6. generate the one-time Matrix `!bind` command on the representative public
   page and send it in that room;
7. send a normal message and verify it appears in Dashboard Conversations;
8. reply from Dashboard and verify the reply arrives in Matrix; and
9. pause/resume Matrix in Channels and verify ingress is rejected/accepted as
   expected; and
10. disconnect/reconnect Matrix, confirming history is retained while delivery
    stops during the disconnected state.

The MVP deliberately excludes encrypted rooms, group rooms, federation,
media, and Telegram-over-Matrix. Adding a third joined member or enabling
encryption must isolate the room.

## Production differences

Production must provide its own:

- stable `MATRIX_SERVER_NAME` and reachable `MATRIX_HOMESERVER_URL`;
- secret-managed `MATRIX_AS_TOKEN` and `MATRIX_AS_HS_TOKEN`;
- Synapse Application Service registration with an exclusive
  `@_delegate_.*` namespace;
- TLS, persistence, backups, monitoring, and an explicit upgrade process.

Do not copy the generated SQLite configuration or local tokens into a hosted
environment.
