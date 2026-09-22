# WeChat Web registration, sign-in and account binding

## Requirements and scope

Use a reviewed **website application** from WeChat Open Platform with WeChat
Login permission. Native/mobile, Official Account and mini-program credentials
are not interchangeable with the website application. This phase implements
browser QR sign-in, not Official Account in-WeChat webpage authorization.

Put credentials in `.local/logto/wechat.env`, which is ignored by Git, with
permissions `0600`:

```dotenv
WECHAT_WEB_APP_ID=
WECHAT_WEB_APP_SECRET=
WECHAT_WEB_CALLBACK_DOMAIN=
```

The callback domain is a bare hostname matching both the approved WeChat domain
and the target Logto public `LOGTO_ENDPOINT`. For the existing public deployment
that would be `login.rag8.cn`, **only if that domain has actually been approved**.
Do not substitute it for a local issuer just to pass a domain check.

The installed Logto 1.41 Web connector uses `appId`, `appSecret`, and
`scope=snsapi_login`, with `https://open.weixin.qq.com/connect/qrconnect`.
Some generic/older Logto documentation refers to different field names and
Official Account scopes; use the pinned runtime contract tests as the source of
truth for this deployment. No new connector package or SDK is necessary.

## Preview and apply

Local preview is read-only:

```sh
LOGTO_BACKCHANNEL_ENDPOINT=http://127.0.0.1:3301 \
node --env-file=.env --env-file=.local/logto/delegate-auth.env \
  --env-file=.local/logto/wechat.env scripts/logto-wechat-auth.mjs
```

Append `--apply` to configure the target environment. The script:

- Verifies discovery's issuer matches the public endpoint; backchannel/issuer
  mismatches fail before writing any credentials.
- Creates or updates one `wechat-web` connector, with profile re-sync disabled.
- Adds `wechat` to the hosted registration and sign-in pages.
- Skips required phone/email/username/password fulfillment for social sign-in,
  so pending SMS delivery does not block WeChat users.
- Disables implicit social account matching by email/phone. Binding is explicit.
- Enables social-identity editing in Logto's built-in Account Center. Existing
  password/email/phone verification states become at least ReadOnly (existing
  Edit remains Edit); other field permissions are preserved. This is required
  for Logto to present existing identity-verification methods and does not grant
  password editing or bypass fresh verification.
- Preserves ordinary login/signup methods, MFA, captcha and existing users.
- Reads back the saved configuration without printing secrets.

Non-loopback activation requires HTTPS and a matching
`WECHAT_WEB_CALLBACK_DOMAIN`. Local activation only prepares and exposes the
local entry; it does not establish that WeChat permits a loopback callback.
The exact callback returned after configuration is
`<LOGTO_ENDPOINT>/callback/<connector-instance-id>`. WeChat returns to Logto,
then Logto returns to Delegate's existing `/auth/callback`; do not configure the
Dashboard callback as the WeChat redirect URI.

For another environment, load that environment's own Management API credentials
and endpoints. Do not reuse the local command against a public issuer with a
local backchannel. Before applying, retain a private configuration backup and
review the preview. The script does not deploy application code or perform a
public-environment configuration change automatically.

Management API configuration is not atomic. A connector or Account Center may
have been prepared before a later failure. The script reports failures and
refuses concurrent policy changes; inspect state before retrying. Repeated apply
updates the same connector and does not create duplicate WeChat targets.

## Existing accounts and identity preservation

An existing Owner should first sign in through their existing method and link
WeChat through `<LOGTO_ENDPOINT>/account/security`. After fresh authorization,
future WeChat login must resolve to that same Logto user, Owner and Account.
Set `LOGTO_ACCOUNT_CENTER_URL` to this Account Center URL in the app environment
to expose it through the existing Settings > Security link after restart.

Do not register a second account and merge it by nickname. If WeChat is already
bound to another account, stop and use an explicit reviewed account-recovery
procedure. Never rewrite an OwnerIdentityLink, issuer or user subject to work
around a binding conflict.

Delegate continues to trust the verified **Logto issuer + sub**, not raw WeChat
OpenID/UnionID. The connector uses UnionID when available and OpenID otherwise;
changing WeChat application, Open Platform relationships or connector identity
mapping later requires a separate migration review. The script rejects replacing
an existing connector with a different AppID. Secret rotation for the same AppID
is supported.

The initial WeChat nickname seeds an Owner name; later provider nicknames do not
overwrite chosen Owner/account display names. Users with identical nicknames
remain separate. WeChat login supplies no phone/email unless separately bound.

Creator registration remains explicit: use the website's Register entry for a
new workspace. Ordinary sign-in does not silently create an Owner or promote an
Audience persona. If a first-time WeChat user starts from Sign in, the existing
registration recovery page leads them to explicit Creator enrollment.

`skipRequiredIdentifiers` is a tenant-wide social policy. If another enabled
provider has a conflicting policy, the script stops instead of changing its
behavior implicitly. Subsequent phone configuration preserves WeChat's social
policy and Account Center binding permission.

## Validation

```sh
pnpm test:logto:wechat
pnpm test:logto:wechat:runtime
pnpm exec vitest run apps/web/tests/creator-auth-admission-routes.test.ts packages/web-data/tests/auth-identities.test.ts apps/reps/tests/public-auth-binding.test.ts
pnpm exec turbo run test --concurrency=1
pnpm typecheck
```

The offline runtime gate loads the actual pinned WeChat connector. It checks QR
scope/state/callback parameters, UnionID/OpenID mapping, nickname extraction,
invalid-code/network failures and configuration schemas. Provider responses are
synthetic and never count as a live end-to-end WeChat login.

Live acceptance requires the correctly approved website application and domain,
a user scanning/consenting in WeChat, a verified OIDC callback, actual Owner and
session persistence, and returning login. Also check cancellation/expired QR,
explicit binding of an existing Owner, preserved workspace/wallet identifiers,
chosen-name preservation, and public Audience login without Owner enrollment.
Never report credential loading or a visible button as proof of successful live
WeChat authentication.
