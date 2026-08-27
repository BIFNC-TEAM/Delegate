# Delegate staging deployment

This deployment targets the existing single-node Docker Swarm on
`8170-server`. It joins the external `traefik-public` network for HTTP ingress
and keeps every data/runtime service on the attachable `delegate-internal`
overlay network.

Public traffic terminates on the Hong Kong `delegate-server` SWAG service at
`47.76.192.252`. The checked-in `hk-swag.subdomain.conf` forwards HTTPS to the
mainland origin with `tsd.rag8.cn` as TLS SNI and preserves each original
`bonary.xyz` Host header for Traefik routing. This avoids the mainland 80/443
policy block while keeping data services private.

## Public routes

- `www.bonary.xyz` -> marketing site
- `dashboard.bonary.xyz` -> owner dashboard
- `delegate.bonary.xyz` -> public representatives
- `login.bonary.xyz` -> Logto core
- `login-admin.bonary.xyz` -> Logto Admin Console using Logto administrator authentication
- `matrix.bonary.xyz` -> Synapse Client/Federation API
- `openviking.bonary.xyz` -> OpenViking Studio/API behind Basic Auth
- `pay.bonary.xyz` -> only the two WeChat Pay notification paths
- `api.bonary.xyz` -> only `/health` and `/ready`

PostgreSQL, MinIO, Temporal, workers, Matrix Application Service, and Compute
Broker publish no host ports.

All nine `bonary.xyz` A records point to `47.76.192.252`. SWAG's existing
`matrix.rag8.cn` ECDSA certificate is expanded to include all public Delegate
domains and renews through standalone HTTP-01. The previous callback-only
`pay.subdomain.conf` is retained as a dated backup on the SWAG volume.

## Publish

From the repository root:

```bash
bash deploy/staging/publish.sh 8170-server
```

The publisher transfers a source-only release, copies the ignored local
environment without printing it, generates staging-specific secrets on the
server, builds commit-tagged images, applies migrations, deploys the stack,
and writes fresh PostgreSQL and Logto backups.

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

- Dashboard redirect: `https://dashboard.bonary.xyz/auth/callback`
- Dashboard post-sign-out: `https://dashboard.bonary.xyz/auth/logout/callback`
- Representatives redirect: `https://delegate.bonary.xyz/auth/callback`
- Representatives post-sign-out:
  `https://delegate.bonary.xyz/reps/lin-founder-rep`

Write the application credentials and webhook signing key to the existing
server file:

```text
/home/ubuntu/delegate/shared/env/auth-apps.env
```

Redeploy the stack after updating that file. SMTP is intentionally deferred.

## Rollback

Each release is stored under `/home/ubuntu/delegate/releases/<release-id>` and
uses release-tagged application images. To roll back, run the previous
release's `server-deploy.sh` with its release id. Database migrations are not
automatically reversed; restore a reviewed backup only for confirmed data
corruption.
