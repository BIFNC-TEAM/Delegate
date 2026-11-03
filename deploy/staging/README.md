# Delegate staging deployment

This deployment targets the existing single-node Docker Swarm on
`8170-server`. It joins the external `traefik-public` network for HTTP ingress
and keeps every data/runtime service on the attachable `delegate-internal`
overlay network.

Public traffic terminates directly on the shared Traefik service at
`8170-server` (`81.70.105.92`). Every public hostname uses the `lehttp`
HTTP-01 resolver. The retired Hong Kong `delegate-server` SWAG hop is not part
of this deployment.

## Public routes

- `home.rag8.cn` -> marketing site
- `dashboard.rag8.cn` -> owner dashboard
- `delegate.rag8.cn` -> public representatives
- `login.rag8.cn` -> Logto core
- `login-admin.rag8.cn` -> Logto Admin Console using Logto administrator authentication
- `delegate-matrix.rag8.cn` -> Synapse Client/Federation API
- `openviking.rag8.cn` -> OpenViking Studio/API behind Basic Auth
- `delegate-pay.rag8.cn` -> only the two WeChat Pay notification paths
- `delegate-api.rag8.cn` -> only `/health` and `/ready`

PostgreSQL, MinIO, Temporal, workers, Matrix Application Service, and Compute
Broker publish no host ports.

All nine public A records point to `81.70.105.92`. Traefik obtains and renews
their certificates through HTTP-01. Synapse keeps its immutable historical
server identity (`matrix.bonary.xyz`) to preserve existing users and rooms,
while its public base URL and ingress use `delegate-matrix.rag8.cn`.

## Publish

From the repository root:

```bash
bash deploy/staging/publish.sh 8170-server
```

The publisher transfers a source-only release, copies the ignored local
environment without printing it, generates staging-specific secrets on the
server, builds commit-tagged images, applies migrations, deploys the stack,
and writes fresh PostgreSQL and Logto backups.

Each release copies the production-built Delegate authentication experience
out of the application image and mounts it read-only into Logto. After Logto
is healthy, deployment applies the private Tencent SMS connector settings when
`/home/ubuntu/delegate/shared/tencent-sms.env` exists with mode `0600`, then
reconciles the reviewed phone registration/sign-in and Account Center policy.
The private SMS file is parsed by Node rather than Docker so quoted Chinese
signature values do not become literal connector data.

The environment generator persists one `OWNER_PROFILE_INTERNAL_TOKEN` in
`state.env`, injects it only into Dashboard and workflow-runner, and gives the
Dashboard the internal `http://workflow-runner:4020` endpoint. This keeps Owner
profile reads and avatar changes on the private overlay network without
exposing the token to the browser or unrelated services.

## Inspect and smoke

```bash
bash deploy/staging/status.sh 8170-server
bash deploy/staging/smoke.sh 8170-server
```

OpenViking operator Basic Auth credentials are stored with mode `0600` at:

```text
/home/ubuntu/delegate/shared/env/operator-access.env
```

Do not paste that file into logs or chat.

## Logto application bootstrap

After the first Logto administrator is created, create two Traditional Web
applications and one Management API machine-to-machine application. Register:

- Dashboard redirect: `https://dashboard.rag8.cn/auth/callback`
- Dashboard post-sign-out: `https://dashboard.rag8.cn/auth/logout/callback`
- Representatives redirect: `https://delegate.rag8.cn/auth/callback`
- Representatives post-sign-out:
  `https://delegate.rag8.cn/reps/lin-founder-rep`

Write the application credentials and webhook signing key to the existing
server file:

```text
/home/ubuntu/delegate/shared/env/auth-apps.env
```

Redeploy the stack after updating that file. Each deployment idempotently
migrates the two application callback origins and any Delegate webhook URL
from the retired `bonary.xyz` origins. SMTP is intentionally deferred.

## Rollback

Each release is stored under `/home/ubuntu/delegate/releases/<release-id>` and
uses release-tagged application images. To roll back, run the previous
release's `server-deploy.sh` with its release id. Database migrations are not
automatically reversed; restore a reviewed backup only for confirmed data
corruption.
