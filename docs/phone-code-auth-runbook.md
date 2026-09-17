# Phone verification-code registration and sign-in

## Scope

Use Tencent Cloud domestic SMS and the existing hosted Logto/OIDC flow.
New users register with a verified mainland China mobile number and a display
name, without choosing a username or password. Existing users sign in with a
phone verification code. WeChat/social login is not added in this phase.

Keep the website's separate Register and Sign in entries. The signed
`creatorFlow=register` state continues to authorize Owner enrollment; verifying
a phone during an ordinary sign-in must not silently create an Owner or promote
an Audience persona. Registering and signing in with the same Logto issuer/sub
resolves to the same Owner, Account and workspace.

The official Logto Tencent connector performs provider signing and delivery.
Our small adapter rejects non-mainland mobile numbers before any provider call
and normalizes `861...` to Tencent's `+861...`. OTP creation, validation, expiry,
one-time use and abuse controls remain in Logto. The hosted UI may still show
its country selector; the server, not a default country selection, enforces
mainland-only delivery. Browser/explicit UI locale can change the default
country, so English users may need to select +86.

New registration collects a required display name (1–80 characters). Incomplete
provider profiles no longer copy a phone number into public Owner or contact
names. Existing chosen names and stored legacy names are not rewritten.

## Credentials

Copy `deploy/logto/tencent-sms.env.example` to the Git-ignored
`.local/logto/tencent-sms.env`, with file permissions `0600`. Supply:

- `TENCENT_SMS_SECRET_ID`, `TENCENT_SMS_SECRET_KEY`: a credential restricted to SMS sending.
- `TENCENT_SMS_SDK_APP_ID`: the Tencent SMS application.
- `TENCENT_SMS_SIGN_NAME`: an approved domestic SMS signature.
- `TENCENT_SMS_TEMPLATE_ID`: an approved verification template with one `{1}` placeholder.
- `TENCENT_SMS_REGION`: defaults to `ap-guangzhou`.
- `TENCENT_SMS_TEST_PHONE`: optional, your own +86 mobile for explicit provider testing.

The template is mapped to Register, SignIn, Generic, ForgotPassword,
UserPermissionValidation and BindNewIdentifier. The latter two cover secure
phone binding; ForgotPassword remains in the connector's required schema even
when password sign-in is disabled.

Configure Tencent recipient/send-frequency controls and a daily spend limit.
The script sets code expiry to at most 300 seconds and failed code attempts to
at most 5, preserving tighter existing limits. It does not disable existing
captcha, MFA, SSO or social-linking policies. Review Logto's existing resend/IP
limits and test actual rejection behavior before public rollout.

## Install and preview locally

`compose.logto.yml` mounts the adapter read-only alongside the official
connector. `pnpm logto:local:up` recreates the local Logto service to refresh its
factory cache; it does not change login configuration. The image stays pinned
to Logto 1.41.0 and connector-kit 5.1.0.

From the repository root, preview with no writes or SMS sends:

```sh
LOGTO_BACKCHANNEL_ENDPOINT=http://127.0.0.1:3301 \
node --env-file=.env --env-file=.local/logto/delegate-auth.env \
  --env-file=.local/logto/tencent-sms.env scripts/logto-phone-auth.mjs
```

The explicit host override is for a CLI running on the Mac host; the app's
existing `host.docker.internal` backchannel is for its containers. Do not change
the OIDC issuer or application IDs as part of the SMS migration.

Preview reports missing settings, connector availability and active users
without a mainland phone, without exposing phone numbers or secrets. It refuses
to replace an already configured different SMS provider. Logto's connector POST
would otherwise delete the previous provider.

## Test delivery and stage the migration

Run the same command with `--test-sms` to explicitly send the official connector's
Generic test message to `TENCENT_SMS_TEST_PHONE`. Tencent accepting the request
does not prove receipt: confirm that the SMS arrives. Its fixed test code is
not a valid authentication code.

Then run the command with `--apply`. This enables phone-only registration and
enables verified phone editing in the built-in Logto Account Center (preserving
other field permissions), and places phone-code sign-in first, while retaining existing non-phone sign-in
methods temporarily. It collects the nickname and reads configuration back to
verify the saved result. It never modifies user identities or existing names.

Existing username users should log in to their original accounts and complete
Logto's required-phone fulfillment with an SMS code. Do not ask them to register
a separate new account. For changing an existing non-mainland number, open
`<LOGTO_ENDPOINT>/account`, verify the original account, then verify the new
mainland phone. Set the app's `LOGTO_ACCOUNT_CENTER_URL` to that URL to expose it
through the existing Settings > Security link after deployment. Verify that the issuer/sub, Owner, Account, workspace,
representatives and wallet remain the same after binding. A phone already owned
by another account is a conflict, not permission to merge or overwrite users.

Configuration uses multiple Management API calls, not a database transaction.
A failure during connector/profile/Account Center preparation leaves login settings unchanged,
but preparation changes may already exist. Inspect them and retry. Run with a
single operator, pause concurrent auth-configuration edits, and avoid changing
user enrollment during final cutover; Logto provides no atomic settings/user
migration transaction. Do not log, print or commit connector config backups.

## Switch off password login

After real registration, login and old-account binding checks pass, preview
again with `--phone-only`, then use `--apply --phone-only`. The script checks all
active users, repeats the check immediately before cutover, and refuses while
any lack a mainland mobile. It removes password/username sign-in and password
recovery methods, without deleting stored credentials or changing the separate
Logto Admin tenant. Keep a reviewed private copy of original sign-in settings
for operational rollback.

If a user cannot access the original account, use the established verified
account-recovery process. Do not insert a phone number directly into Logto's
user table as a substitute for ownership verification.

## Staging deployment

`deploy/staging/server-deploy.sh` binds the adapter from that exact release's
`deploy/logto/connectors/connector-tencent-sms-cn` directory. Manual stack deploys
must set `DELEGATE_LOGTO_CONNECTOR_ROOT` to that absolute directory on the
scheduled node. Mount it identically on every replica; a changed release path
causes service replacement and refreshes the connector cache. The deployment
does not automatically enable SMS or disable legacy login.

Run the same Management API configuration command using the **staging** private
environment and reachable Logto endpoint, not the local env files. The tenant
sign-in experience can affect both Dashboard Owners and public-page Audiences;
test both. No production deployment or configuration mutation is implied by
these repository changes.

## Verification

```sh
pnpm test:logto:phone
pnpm test:logto:phone:runtime
pnpm test:logto:config
pnpm exec vitest run packages/web-data/tests/auth-identities.test.ts packages/web-data/tests/auth-session.test.ts apps/web/tests/creator-auth-admission-routes.test.ts apps/reps/tests/public-auth-binding.test.ts
node --test deploy/staging/tests/stack-contract.test.mjs
pnpm exec turbo run test --concurrency=1
```

The runtime gate loads the real adapter and validates generated config against
the pinned Logto image, offline. Unit tests use mocked SMS/Management API calls
and signed test ID tokens; they do not prove carrier delivery or real OTP
interaction. Before enabling the service, manually verify: new phone
registration and nickname, returning phone login, old-account binding, wrong/
expired/replayed codes, resend limits, foreign-number rejection, provider
failure, and public Audience login with no accidental Owner enrollment.
