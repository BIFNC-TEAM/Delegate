import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { buildPhoneAuthPlan, configurePhoneAuth, createManagementClient, listUsers, parseArgs, readSmsConfig } from "../logto-phone-auth.mjs";
import { mainlandMobileNumber, withMainlandRecipients } from "../../deploy/logto/connectors/connector-tencent-sms-cn/lib/phone.js";

const env = {
  TENCENT_SMS_SECRET_ID: "test-id", TENCENT_SMS_SECRET_KEY: "test-secret",
  TENCENT_SMS_SDK_APP_ID: "test-app", TENCENT_SMS_SIGN_NAME: "test-sign",
  TENCENT_SMS_TEMPLATE_ID: "test-template",
};

function fixture() {
  const state = {
    experience: {
      signIn: { methods: [{ identifier: "username", password: true, verificationCode: false, isPasswordPrimary: true }] },
      signUp: { identifiers: ["username"], password: true, verify: false },
      signUpProfileFields: [],
      verificationCodePolicy: {},
      mfa: { policy: "Mandatory", factors: ["Totp"] },
      socialSignIn: { automaticAccountLinking: false },
    },
    accountCenter: { enabled: false, fields: { email: "ReadOnly", password: "Off" } },
    connectors: [], factories: [{ id: "delegate-tencent-sms-cn", type: "Sms" }],
    fields: [], users: [{ id: "legacy", primaryPhone: null, isSuspended: false }],
  };
  const request = vi.fn(async (path, method = "GET", body) => {
    if (path === "/api/sign-in-exp") {
      if (method === "PATCH") Object.assign(state.experience, body);
      return structuredClone(state.experience);
    }
    if (path === "/api/account-center") {
      if (method === "PATCH") Object.assign(state.accountCenter, body);
      return structuredClone(state.accountCenter);
    }
    if (path === "/api/connectors") return state.connectors;
    if (path === "/api/connector-factories") return state.factories;
    if (path === "/api/custom-profile-fields") return state.fields;
    if (path.startsWith("/api/users?")) return state.users;
    return {};
  });
  return { state, request };
}

const mutations = (request) => request.mock.calls.filter(([, method]) => method && method !== "GET");

describe("mainland Tencent SMS adapter", () => {
  it.each(["8613800138000", "+8613800138000"])("normalizes %s to an E.164 recipient", (phone) => {
    expect(mainlandMobileNumber(phone)).toBe("+8613800138000");
  });
  it.each(["13800138000", "+85291234567", "+14155552671", "8612345678901", "8601012345678", " 8613800138000", "8613800138000,8613900138000", null])("rejects unsupported receiver %j before contacting Tencent", async (phone) => {
    const send = vi.fn();
    await expect(withMainlandRecipients(send, () => new Error("unsupported phone"))({ to: phone })).rejects.toThrow("unsupported phone");
    expect(send).not.toHaveBeenCalled();
  });
  it("preserves the upstream OTP payload and propagates provider rejection", async () => {
    const send = vi.fn().mockRejectedValue(new Error("provider rejected"));
    const data = { to: "8613800138000", type: "Register", payload: { code: "123456", locale: "zh-CN" } };
    await expect(withMainlandRecipients(send, () => new Error("invalid"))(data, { test: true })).rejects.toThrow("provider rejected");
    expect(send).toHaveBeenCalledWith({ ...data, to: "+8613800138000" }, { test: true });
  });
});

describe("Logto phone registration configuration", () => {
  it("uses passwordless, verified phone registration and a migration login path", () => {
    const { state } = fixture();
    const plan = buildPhoneAuthPlan(state);
    expect(plan.patch.signUp).toEqual({ identifiers: ["phone"], password: false, verify: true, secondaryIdentifiers: [] });
    expect(plan.patch.signIn.methods).toEqual([
      { identifier: "phone", password: false, verificationCode: true, isPasswordPrimary: false },
      state.experience.signIn.methods[0],
    ]);
    expect(plan.patch.signUpProfileFields).toEqual([{ name: "name" }]);
    expect(plan.nameField).toMatchObject({ name: "name", required: true, config: { minLength: 1, maxLength: 80 } });
    expect(plan.patch).not.toHaveProperty("mfa");
    expect(plan.patch).not.toHaveProperty("socialSignIn");
    expect(plan.patch).not.toHaveProperty("captchaPolicy");
  });
  it("does not loosen stricter existing OTP limits", () => {
    const { state } = fixture();
    state.experience.verificationCodePolicy = { expirationDuration: 120, maxRetryAttempts: 3 };
    expect(buildPhoneAuthPlan(state).patch.verificationCodePolicy).toEqual({ expirationDuration: 120, maxRetryAttempts: 3 });
  });
  it("previews without credentials, mutations, or exposing user identifiers", async () => {
    const { request } = fixture();
    const result = await configurePhoneAuth(parseArgs([]), {}, request);
    expect(result).toMatchObject({ applied: false, activeUsersWithoutMainlandPhone: 1 });
    expect(result.missingSmsSettings).toContain("TENCENT_SMS_SECRET_KEY");
    expect(mutations(request)).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('"legacy"');
  });
  it("applies migration mode without silently disabling old accounts", async () => {
    const { request, state } = fixture();
    expect(await configurePhoneAuth(parseArgs(["--apply"]), env, request)).toMatchObject({ applied: true, mode: "migration" });
    expect(state.experience.signIn.methods).toHaveLength(2);
    expect(state.accountCenter).toEqual({ enabled: true, fields: { email: "ReadOnly", password: "Off", phone: "Edit" } });
    expect(state.experience.mfa).toEqual({ policy: "Mandatory", factors: ["Totp"] });
    expect(mutations(request).map(([path]) => path)).toEqual(["/api/connectors", "/api/custom-profile-fields", "/api/account-center", "/api/sign-in-exp"]);
  });
  it("blocks final cutover before any write if a user lacks a mainland phone", async () => {
    const { request } = fixture();
    await expect(configurePhoneAuth(parseArgs(["--apply", "--phone-only"]), env, request)).rejects.toThrow("active users need mainland phone binding");
    expect(mutations(request)).toHaveLength(0);
  });
  it("allows phone-only mode once active users have mainland phone identities", async () => {
    const { request, state } = fixture();
    state.users[0].primaryPhone = "8613800138000";
    expect(await configurePhoneAuth(parseArgs(["--apply", "--phone-only"]), env, request)).toMatchObject({ applied: true, mode: "phone_only" });
    expect(state.experience.signIn.methods).toEqual([{ identifier: "phone", password: false, verificationCode: true, isPasswordPrimary: false }]);
  });
  it("does not overwrite another configured SMS provider", () => {
    const { state } = fixture();
    state.connectors.push({ id: "sms-old", type: "Sms", connectorId: "other-provider" });
    expect(() => buildPhoneAuthPlan(state)).toThrow("refusing to replace");
  });
  it("updates its own connector instead of creating duplicates", async () => {
    const { state, request } = fixture();
    state.connectors.push({ id: "existing", type: "Sms", connectorId: "delegate-tencent-sms-cn" });
    await configurePhoneAuth(parseArgs(["--apply"]), env, request);
    expect(mutations(request)[0].slice(0, 2)).toEqual(["/api/connectors/existing", "PATCH"]);
  });
  it("fails before writes when credentials or the connector package are absent", async () => {
    const f = fixture();
    await expect(configurePhoneAuth(parseArgs(["--apply"]), {}, f.request)).rejects.toThrow("Missing SMS settings");
    expect(mutations(f.request)).toHaveLength(0);
    f.state.factories = [];
    await expect(configurePhoneAuth(parseArgs(["--apply"]), env, f.request)).rejects.toThrow("Install the mainland");
    expect(mutations(f.request)).toHaveLength(0);
  });
  it("does not change login settings if preparing the nickname field fails", async () => {
    const f = fixture();
    const request = vi.fn(async (path, method, body) => {
      if (path === "/api/custom-profile-fields" && method === "POST") throw new Error("upstream unavailable");
      return f.request(path, method, body);
    });
    await expect(configurePhoneAuth(parseArgs(["--apply"]), env, request)).rejects.toThrow("upstream unavailable");
    expect(mutations(request).some(([path]) => path === "/api/sign-in-exp")).toBe(false);
  });
  it("detects an administrator changing login settings during preparation", async () => {
    const f = fixture();
    const request = vi.fn(async (path, method, body) => {
      if (path === "/api/custom-profile-fields" && method === "POST") f.state.experience.signIn.methods = [];
      return f.request(path, method, body);
    });
    await expect(configurePhoneAuth(parseArgs(["--apply"]), env, request)).rejects.toThrow("changed during preparation");
    expect(mutations(request).some(([path]) => path === "/api/sign-in-exp")).toBe(false);
  });
  it("compares persisted JSON semantically even when the database reorders object keys", async () => {
    const f = fixture();
    const reorder = (value) => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, reorder(value[key])])) : value;
    const request = async (path, method, body) => reorder(await f.request(path, method, body));
    expect(await configurePhoneAuth(parseArgs(["--apply"]), env, request)).toMatchObject({ applied: true });
  });
  it("reports a read-back mismatch instead of claiming configuration succeeded", async () => {
    const f = fixture();
    const request = async (path, method, body) => {
      if (path === "/api/sign-in-exp" && method === "PATCH") return {};
      return f.request(path, method, body);
    };
    await expect(configurePhoneAuth(parseArgs(["--apply"]), env, request)).rejects.toThrow("read-back did not match");
  });
  it("rechecks migration coverage immediately before the final cutover", async () => {
    const f = fixture();
    f.state.users[0].primaryPhone = "8613800138000";
    const request = async (path, method, body) => {
      if (path === "/api/custom-profile-fields" && method === "POST") f.state.users.push({ id: "late-user", primaryPhone: null, isSuspended: false });
      return f.request(path, method, body);
    };
    await expect(configurePhoneAuth(parseArgs(["--apply", "--phone-only"]), env, request)).rejects.toThrow("Migration coverage changed");
    expect(mutations(f.request).some(([path]) => path === "/api/sign-in-exp")).toBe(false);
  });

  it("requires complete and well-shaped user enumeration", async () => {
    const request = vi.fn().mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ id: `${i}`, isSuspended: false }))).mockResolvedValueOnce([{ id: "last", isSuspended: false }]);
    expect(await listUsers(request)).toHaveLength(101);
    await expect(listUsers(vi.fn().mockResolvedValue({ error: "invalid" }))).rejects.toThrow("Invalid Logto users");
    const { state } = fixture();
    state.users = [{ id: "no-status" }];
    expect(() => buildPhoneAuthPlan(state)).toThrow("Invalid Logto configuration");
    await expect(listUsers(vi.fn().mockResolvedValue([{ id: "malformed", isSuspended: false, primaryPhone: 8613800138000 }]))).rejects.toThrow("Invalid Logto users");
  });
  it("configures every required OTP use case and never emits secret values", () => {
    expect(readSmsConfig(env).templates.map(({ usageType }) => usageType)).toEqual(["Register", "SignIn", "Generic", "ForgotPassword", "UserPermissionValidation", "BindNewIdentifier"]);
    expect(() => readSmsConfig({ ...env, TENCENT_SMS_SECRET_KEY: "" })).toThrow("TENCENT_SMS_SECRET_KEY");
  });
  it("sends provider smoke SMS only through the explicit test mode", async () => {
    const { request } = fixture();
    expect(await configurePhoneAuth(parseArgs(["--test-sms"]), { ...env, TENCENT_SMS_TEST_PHONE: "+8613800138000" }, request)).toMatchObject({ smsTest: "provider_accepted" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][2].phone).toBe("8613800138000");
    expect(() => parseArgs(["--apply", "--test-sms"])).toThrow("separately");
  });
  it("rejects unsupported CLI flags rather than accidentally applying", () => {
    for (const args of [["--force"], ["--apply", "--apply"], ["--dry-run", "--apply"]]) expect(() => parseArgs(args)).toThrow();
  });
  it("redacts upstream error bodies and fails closed on network failures", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "private-token" })))
      .mockResolvedValueOnce(new Response("secret config", { status: 503 }));
    const config = { LOGTO_ENDPOINT: "https://auth.example.com", LOGTO_M2M_APP_ID: "id", LOGTO_M2M_APP_SECRET: "secret" };
    await expect(createManagementClient(config, fetch)("/api/sign-in-exp")).rejects.toThrow("Logto GET /api/sign-in-exp failed (503)");
    expect(fetch.mock.calls[1][1].redirect).toBe("error");
    await expect(createManagementClient(config, vi.fn().mockRejectedValue(new Error("network failure")))("/api/sign-in-exp")).rejects.toThrow("network failure");
  });
  it("mounts the bounded connector read-only in local Logto", () => {
    const compose = readFileSync(new URL("../../compose.logto.yml", import.meta.url), "utf8");
    expect(compose).toContain("connector-tencent-sms-cn:/etc/logto/packages/core/connectors/@delegate-connector-tencent-sms-cn:ro");
  });
});
