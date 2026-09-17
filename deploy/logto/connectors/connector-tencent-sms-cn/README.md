# Tencent SMS for mainland China

A bounded adapter for the official Tencent SMS connector shipped with Logto
1.41.0. It rejects non-mainland/mobile recipients before any provider request,
normalizes Logto's `861...` representation to `+861...`, and otherwise delegates
to the official connector unchanged. It never generates, logs or stores codes.

Mount this directory at
`/etc/logto/packages/core/connectors/@delegate-connector-tencent-sms-cn` and
restart Logto to refresh its connector-factory cache. The official
`@logto-connector-tencent-sms` sibling must remain installed. No npm installation
or extra runtime dependencies are needed in that image.

Configuration is the official Tencent connector schema. Include templates for
Register, SignIn, Generic, ForgotPassword, UserPermissionValidation and
BindNewIdentifier. Use a reviewed, single-code-placeholder Tencent template.

The region check does not replace Logto rate limits or Tencent recipient/IP
frequency and daily spend limits. See `docs/phone-code-auth-runbook.md` in the
Delegate repository for staged migration and operational checks.
