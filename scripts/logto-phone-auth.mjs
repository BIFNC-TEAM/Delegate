import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { connectorId, mainlandMobileNumber } from "../deploy/logto/connectors/connector-tencent-sms-cn/lib/phone.js";

const templateUsages = ["Register", "SignIn", "Generic", "ForgotPassword", "UserPermissionValidation", "BindNewIdentifier"];
const smsKeys = ["TENCENT_SMS_SECRET_ID", "TENCENT_SMS_SECRET_KEY", "TENCENT_SMS_SDK_APP_ID", "TENCENT_SMS_SIGN_NAME", "TENCENT_SMS_TEMPLATE_ID"];
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validUser = (user) => isRecord(user) && typeof user.id === "string" && Boolean(user.id)
  && typeof user.isSuspended === "boolean"
  && (user.primaryPhone == null || typeof user.primaryPhone === "string");

export function readSmsConfig(env) {
  const missing = smsKeys.filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`Missing SMS settings: ${missing.join(", ")}`);
  return {
    accessKeyId: env.TENCENT_SMS_SECRET_ID.trim(),
    accessKeySecret: env.TENCENT_SMS_SECRET_KEY.trim(),
    sdkAppId: env.TENCENT_SMS_SDK_APP_ID.trim(),
    signName: env.TENCENT_SMS_SIGN_NAME.trim(),
    region: env.TENCENT_SMS_REGION?.trim() || "ap-guangzhou",
    templates: templateUsages.map((usageType) => ({ usageType, templateCode: env.TENCENT_SMS_TEMPLATE_ID.trim() })),
  };
}

export function parseArgs(args) {
  if (new Set(args).size !== args.length || args.some((arg) => !["--apply", "--phone-only", "--test-sms"].includes(arg))) {
    throw new Error("Usage: logto-phone-auth.mjs [--apply] [--phone-only] | --test-sms");
  }
  if (args.includes("--test-sms") && args.length !== 1) throw new Error("Run --test-sms separately from configuration changes.");
  return { apply: args.includes("--apply"), phoneOnly: args.includes("--phone-only"), testSms: args.includes("--test-sms") };
}

export function buildPhoneAuthPlan(state, { phoneOnly = false } = {}) {
  const { experience, connectors, factories, fields, users, accountCenter } = state;
  if (
    !isRecord(accountCenter) || typeof accountCenter.enabled !== "boolean" || !isRecord(accountCenter.fields)
    || !isRecord(experience?.signIn) || !Array.isArray(experience.signIn.methods)
    || !isRecord(experience.signUp) || !Array.isArray(connectors)
    || !Array.isArray(factories) || !Array.isArray(fields) || !Array.isArray(users)
    || connectors.some((item) => !isRecord(item) || typeof item.id !== "string" || typeof item.type !== "string")
    || users.some((user) => !validUser(user))
  ) throw new Error("Invalid Logto configuration response.");

  const oldMethods = experience.signIn.methods;
  if (oldMethods.some((method) => !isRecord(method)
    || !["phone", "email", "username"].includes(method.identifier)
    || ["password", "verificationCode", "isPasswordPrimary"].some((key) => typeof method[key] !== "boolean"))) {
    throw new Error("Invalid Logto sign-in methods.");
  }
  const factoryInstalled = factories.some((factory) => factory?.id === connectorId && factory.type === "Sms");
  const smsConnectors = connectors.filter((item) => item.type === "Sms");
  if (smsConnectors.length > 1 || smsConnectors.some((item) => item.connectorId !== connectorId)) {
    // POST /connectors deletes an existing connector of the same type in Logto.
    // Never implicitly replace a provider that may already serve real users.
    throw new Error("An existing SMS provider requires an explicit migration; refusing to replace it.");
  }
  const unmigrated = users.filter((user) => !user.isSuspended && !/^861[3-9]\d{9}$/u.test(user.primaryPhone ?? ""));
  const existingName = fields.find((field) => field?.name === "name");
  if (existingName && existingName.type !== "Text") throw new Error("Review the existing non-text name profile field before proceeding.");
  const nameField = {
    name: "name", type: "Text", required: true,
    label: existingName?.label || "显示名称",
    description: existingName?.description || "用于展示你的身份，请勿填写手机号。",
    config: {
      ...existingName?.config,
      minLength: Math.max(existingName?.config?.minLength ?? 1, 1),
      maxLength: Math.min(existingName?.config?.maxLength ?? 80, 80),
    },
  };
  if (nameField.config.minLength > nameField.config.maxLength) throw new Error("Review the existing name length limits before proceeding.");
  const profileFields = experience.signUpProfileFields ?? fields.filter((field) => field.sieOrder >= 0).map(({ name }) => ({ name }));
  if (!Array.isArray(profileFields)) throw new Error("Invalid Logto sign-up profile fields.");
  return {
    factoryInstalled,
    connector: smsConnectors[0] ?? null,
    existingName: Boolean(existingName),
    accountCenterPatch: { enabled: true, fields: { ...accountCenter.fields, phone: "Edit" } },
    nameField,
    unmigratedUserIds: unmigrated.map(({ id }) => id),
    // Keep the separate, signed Creator registration intent. Phone verification
    // does not silently promote an Audience account into an Owner.
    patch: {
      signUp: { identifiers: ["phone"], password: false, verify: true, secondaryIdentifiers: [] },
      signIn: { methods: [
        { identifier: "phone", password: false, verificationCode: true, isPasswordPrimary: false },
        ...(phoneOnly ? [] : oldMethods.filter(({ identifier }) => identifier !== "phone")),
      ] },
      ...(phoneOnly ? { forgotPasswordMethods: [] } : {}),
      languageInfo: { autoDetect: false, fallbackLanguage: "zh-CN" },
      signUpProfileFields: [...profileFields.filter(({ name }) => name !== "name"), { name: "name" }],
      verificationCodePolicy: {
        expirationDuration: Math.min(experience.verificationCodePolicy?.expirationDuration ?? 300, 300),
        maxRetryAttempts: Math.min(experience.verificationCodePolicy?.maxRetryAttempts ?? 5, 5),
      },
    },
  };
}

export function createManagementClient(env, fetchImpl = fetch) {
  const endpoint = new URL(env.LOGTO_BACKCHANNEL_ENDPOINT || env.LOGTO_ENDPOINT || "");
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error("Logto endpoint must be an HTTP(S) origin without credentials.");
  }
  const clientId = env.LOGTO_MANAGEMENT_APP_ID || env.LOGTO_M2M_APP_ID;
  const clientSecret = env.LOGTO_MANAGEMENT_APP_SECRET || env.LOGTO_M2M_APP_SECRET;
  if (!clientId || !clientSecret) throw new Error("Logto Management API credentials are required.");
  let token;
  return async (path, method = "GET", body) => {
    if (!token) {
      const response = await fetchImpl(new URL("/oidc/token", endpoint), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", resource: env.LOGTO_MANAGEMENT_API_RESOURCE || "https://default.logto.app/api", scope: "all" }),
      });
      const payload = await response.json();
      if (!response.ok || typeof payload?.access_token !== "string" || !payload.access_token) throw new Error(`Logto token request failed (${response.status}).`);
      token = payload.access_token;
    }
    const response = await fetchImpl(new URL(path, endpoint), {
      method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Error bodies may contain user data or connector credentials. Never print them.
    if (!response.ok) throw new Error(`Logto ${method} ${path.split("?")[0]} failed (${response.status}).`);
    return response.status === 204 ? null : response.json();
  };
}

export async function listUsers(request) {
  const users = [];
  for (let page = 1; page <= 1_000; page += 1) {
    const batch = await request(`/api/users?page=${page}&page_size=100`);
    if (!Array.isArray(batch) || batch.some((user) => !validUser(user))) throw new Error("Invalid Logto users response.");
    users.push(...batch);
    if (batch.length < 100) return users;
  }
  throw new Error("User listing did not complete; refusing a partial migration check.");
}

export async function configurePhoneAuth(options, env, request = createManagementClient(env)) {
  if (options.testSms) {
    const phone = mainlandMobileNumber(env.TENCENT_SMS_TEST_PHONE).slice(1);
    await request(`/api/connectors/${connectorId}/test`, "POST", { phone, config: readSmsConfig(env), locale: "zh-CN" });
    return { smsTest: "provider_accepted", note: "Confirm receipt on the configured phone; this does not prove real sign-up/sign-in." };
  }
  const [experience, connectors, factories, fields, users, accountCenter] = await Promise.all([
    request("/api/sign-in-exp"), request("/api/connectors"), request("/api/connector-factories"), request("/api/custom-profile-fields"), listUsers(request), request("/api/account-center"),
  ]);
  const plan = buildPhoneAuthPlan({ experience, connectors, factories, fields, users, accountCenter }, options);
  const missingSmsSettings = smsKeys.filter((key) => !env[key]?.trim());
  const summary = {
    mode: options.phoneOnly ? "phone_only" : "migration",
    applied: false,
    factoryInstalled: plan.factoryInstalled,
    missingSmsSettings,
    activeUsersWithoutMainlandPhone: plan.unmigratedUserIds.length,
    requiresLegacyAccess: plan.unmigratedUserIds.length > 0,
    signUp: plan.patch.signUp,
    signIn: plan.patch.signIn,
    collectsDisplayName: true,
    enablesVerifiedPhoneBinding: true,
  };
  if (!options.apply) return summary;
  if (!plan.factoryInstalled) throw new Error("Install the mainland Tencent SMS connector and restart Logto first.");
  const config = readSmsConfig(env);
  if (options.phoneOnly && plan.unmigratedUserIds.length) {
    throw new Error(`Cannot disable legacy access: ${plan.unmigratedUserIds.length} active users need mainland phone binding.`);
  }
  // Validate all prerequisites before the first mutation. Preserve unrelated
  // connector, MFA, captcha, SSO, branding and social-account-linking settings.
  const connectorPath = plan.connector ? `/api/connectors/${encodeURIComponent(plan.connector.id)}` : "/api/connectors";
  await request(connectorPath, plan.connector ? "PATCH" : "POST", plan.connector ? { config } : { connectorId, config });
  await request(plan.existingName ? "/api/custom-profile-fields/name" : "/api/custom-profile-fields", plan.existingName ? "PUT" : "POST", plan.nameField);
  const currentAccountCenter = await request("/api/account-center");
  if (!isDeepStrictEqual(currentAccountCenter, accountCenter)) {
    throw new Error("Logto account center settings changed; preview again before enabling phone binding.");
  }
  await request("/api/account-center", "PATCH", plan.accountCenterPatch);
  const current = await request("/api/sign-in-exp");
  if (!isDeepStrictEqual(current, experience)) {
    throw new Error("Sign-in settings changed during preparation; no login settings were applied. Preview again.");
  }
  // Recheck users immediately before disabling the old methods.
  if (options.phoneOnly && (await listUsers(request)).some((user) => !user.isSuspended && !/^861[3-9]\d{9}$/u.test(user.primaryPhone ?? ""))) {
    throw new Error("Migration coverage changed; legacy login remains enabled.");
  }
  await request("/api/sign-in-exp", "PATCH", plan.patch);
  const saved = await request("/api/sign-in-exp");
  const savedAccountCenter = await request("/api/account-center");
  if (savedAccountCenter.enabled !== true || !isDeepStrictEqual(savedAccountCenter.fields, plan.accountCenterPatch.fields)) {
    throw new Error("Logto account center read-back did not match; inspect settings before retrying.");
  }
  if (Object.entries(plan.patch).some(([key, value]) => !isDeepStrictEqual(saved[key], value))) {
    throw new Error("Logto configuration read-back did not match; inspect settings before retrying.");
  }
  return { ...summary, applied: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await configurePhoneAuth(parseArgs(process.argv.slice(2)), process.env);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    // Keep the failure visible without raw fetch/JSON/SDK bodies or secrets.
    const known = error instanceof Error && /^(Missing SMS|Usage:|Run --test|Invalid Logto|An existing|Review the|Logto |User listing|Install the|Cannot disable|Sign-in settings|Migration coverage|Only mainland)/u.test(error.message);
    process.stderr.write(`${known ? error.message : "Phone authentication configuration failed; check the private environment and service connectivity."}\n`);
    process.exitCode = 1;
  }
}
