# Tencent Cloud SES email verification

Loaded alongside the official connectors in pinned Logto 1.41.0. Uses the Tencent
Cloud SES SendEmail API (2020-10-02), TC3-HMAC-SHA256, and an approved template.
No SMTP service or additional SDK is required.

Configure a verified sender domain/address and approved template with `{{code}}` and `{{expireMinutes}}`
variables in the SAME region (ap-guangzhou or ap-hongkong). Supply credentials with
SES SendEmail permission via a private `.local/logto/tencent-ses.env` file; see
`deploy/logto/tencent-ses.env.example`. Never put credentials in Git or frontend assets.

The connector supports only Logto OTP verification usages and one recipient per
request. Network errors, API failures and malformed success responses fail closed;
requests are not automatically retried to avoid duplicate delivery after timeout.
API acceptance does not prove inbox delivery. Existing Logto verification records,
expiry, attempt limits and account-binding proof checks remain authoritative.

The setup tool derives `expireMinutes` from the actual Logto verification-code
policy (seconds / 60); it is not a secret or a separately configured environment
variable. The unified-auth tool rejects mismatched template/policy expiration.
After manually changing the policy in Logto, rerun SES setup before sending mail.
