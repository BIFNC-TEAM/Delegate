// Run inside the pinned svhd/logto:1.41.0 image; no network or credentials needed.
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConnector } from "/etc/logto/packages/cli/lib/connector/loader.js";
import { parseMetadata, validateConnectorModule } from "/etc/logto/packages/cli/lib/connector/utils.js";
import { AccountCenters, SignInExperiences, customProfileFieldUnionGuard } from "/etc/logto/packages/schemas/lib/index.js";
import { buildPhoneAuthPlan, readSmsConfig } from "../logto-phone-auth.mjs";

const directory = "/etc/logto/packages/core/connectors/@delegate-connector-tencent-sms-cn";
const factory = await loadConnector(directory, false);
const connector = await factory({ getConfig: async () => { throw new Error("must not access config for invalid receivers"); } });

test("Logto 1.41 loads and validates the mainland Tencent connector", async () => {
  validateConnectorModule(connector);
  assert.equal(connector.type, "Sms");
  const metadata = await parseMetadata(connector.metadata, directory);
  assert.equal(metadata.id, "delegate-tencent-sms-cn");
  assert.match(metadata.logo, /^data:image\/svg\+xml;base64,/u);
  assert.match(metadata.readme, /mainland China/u);
});

test("real connector rejects non-mainland recipients before configuration or network access", async () => {
  await assert.rejects(connector.sendMessage({ to: "14155552671", type: "SignIn", payload: { code: "123456" } }), /mainland China/u);
});

test("generated Tencent credentials/templates pass the real upstream configuration guard", () => {
  connector.configGuard.parse(readSmsConfig({
    TENCENT_SMS_SECRET_ID: "fixture", TENCENT_SMS_SECRET_KEY: "fixture",
    TENCENT_SMS_SIGN_NAME: "fixture", TENCENT_SMS_SDK_APP_ID: "fixture", TENCENT_SMS_TEMPLATE_ID: "fixture",
  }));
});

test("registration, verification policy and nickname collection match actual Logto schemas", () => {
  const plan = buildPhoneAuthPlan({
    experience: { signIn: { methods: [] }, signUp: {}, signUpProfileFields: [] },
    connectors: [], factories: [], fields: [], users: [], accountCenter: { enabled: false, fields: {} },
  });
  SignInExperiences.createGuard.partial().parse(plan.patch);
  customProfileFieldUnionGuard.parse(plan.nameField);
  AccountCenters.createGuard.partial().parse(plan.accountCenterPatch);
});
