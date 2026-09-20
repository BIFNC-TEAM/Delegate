import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import { createManagementClient } from "./logto-phone-auth.mjs";

export const wechatFactoryId = "wechat-web";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function readWechatConfig(env) {
  const appId = env.WECHAT_WEB_APP_ID?.trim();
  const appSecret = env.WECHAT_WEB_APP_SECRET?.trim();
  if (!appId || !/^wx[0-9a-f]{16}$/iu.test(appId)) throw new Error("WeChat website AppID is missing or invalid.");
  if (!appSecret || /\s/u.test(appSecret)) throw new Error("WeChat website AppSecret is missing or invalid.");
  // The installed Logto 1.41 Web connector uses qrconnect, not the Official
  // Account's snsapi_base/snsapi_userinfo flow. Never mix the two app types.
  return { appId, appSecret, scope: "snsapi_login" };
}

export function readWechatPublicOrigin(env) {
  const url = new URL(env.LOGTO_ENDPOINT || "");
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error("WeChat requires LOGTO_ENDPOINT to be a public HTTP(S) origin without credentials.");
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('WeChat public endpoints must use HTTPS.');
  }
  const configuredDomain = env.WECHAT_WEB_CALLBACK_DOMAIN?.trim().toLowerCase();
  if (configuredDomain && (configuredDomain.includes('/') || configuredDomain.includes(':') || configuredDomain !== url.hostname.toLowerCase())) {
    throw new Error("WeChat authorized callback domain does not match LOGTO_ENDPOINT.");
  }
  return url.origin;
}

export function buildWechatAuthPlan(state, config) {
  const { connectors, factories, experience, accountCenter } = state;
  if (!Array.isArray(connectors) || !Array.isArray(factories)
    || !isRecord(experience) || !Array.isArray(experience.socialSignInConnectorTargets)
    || !isRecord(experience.socialSignIn) || !isRecord(accountCenter)
    || typeof accountCenter.enabled !== 'boolean' || !isRecord(accountCenter.fields)
    || experience.socialSignInConnectorTargets.some((target) => typeof target !== 'string')
    || connectors.some((item) => !isRecord(item) || typeof item.id !== 'string' || typeof item.connectorId !== 'string')) {
    throw new Error("WeChat configuration received an invalid Logto response.");
  }
  const matches = connectors.filter(({ connectorId }) => connectorId === wechatFactoryId);
  if (matches.length > 1) throw new Error("WeChat has multiple Web connectors; review them before applying.");
  const connector = matches[0] ?? null;
  if (connector && (!isRecord(connector.config) || connector.config.appId !== config.appId)) {
    // Changing AppID could change OpenID/UnionID mappings and orphan accounts.
    throw new Error("WeChat AppID differs from the existing connector; an identity migration is required.");
  }
  if (connectors.some((item) => item.target === 'wechat' && item.platform === 'Web' && item.connectorId !== wechatFactoryId)) {
    throw new Error("WeChat Web target is already owned by a different connector.");
  }
  const targets = experience.socialSignInConnectorTargets;
  const otherTargets = targets.filter((target) => target !== 'wechat');
  if (otherTargets.length && (experience.socialSignIn.skipRequiredIdentifiers !== true || experience.socialSignIn.automaticAccountLinking !== false)) {
    throw new Error("WeChat policy would also change other social providers; review their enrollment policy first.");
  }
  return {
    factoryInstalled: factories.some((item) => item?.id === wechatFactoryId && item.type === 'Social' && item.platform === 'Web'),
    connector,
    experiencePatch: {
      socialSignInConnectorTargets: [...new Set([...targets, 'wechat'])],
      socialSignIn: {
        ...experience.socialSignIn,
        // New WeChat users may have no phone/email/username/password. They must
        // still consent to explicit Creator enrollment in Delegate's callback.
        skipRequiredIdentifiers: true,
        automaticAccountLinking: false,
      },
    },
    accountCenterPatch: {
      enabled: true,
      fields: {
        ...accountCenter.fields,
        // Logto filters hasPassword/primaryEmail/primaryPhone by these controls.
        // Hiding them prevents existing users from verifying identity to bind
        // WeChat, even though the underlying credential exists. ReadOnly does
        // not permit password changes or bypass step-up verification.
        ...Object.fromEntries(['password', 'email', 'phone'].map((field) => [
          field, accountCenter.fields[field] === 'Edit' ? 'Edit' : 'ReadOnly',
        ])),
        social: 'Edit',
      },
    },
  };
}

export function parseWechatArgs(args) {
  if (args.length === 0) return { apply: false };
  if (args.length === 1 && args[0] === '--apply') return { apply: true };
  throw new Error("Usage: logto-wechat-auth.mjs [--apply]");
}

export async function configureWechatAuth(options, env, request = createManagementClient(env)) {
  const config = readWechatConfig(env);
  const publicOrigin = readWechatPublicOrigin(env);
  const [connectors, factories, experience, accountCenter, discovery] = await Promise.all([
    request('/api/connectors'), request('/api/connector-factories'), request('/api/sign-in-exp'), request('/api/account-center'), request('/oidc/.well-known/openid-configuration'),
  ]);
  if (discovery?.issuer !== `${publicOrigin}/oidc`) {
    throw new Error("WeChat target issuer does not match LOGTO_ENDPOINT; refusing cross-environment configuration.");
  }
  const plan = buildWechatAuthPlan({ connectors, factories, experience, accountCenter }, config);
  const callbackUrl = (id) => new URL(`/callback/${encodeURIComponent(id)}`, publicOrigin).toString();
  const summary = {
    applied: false,
    factoryInstalled: plan.factoryInstalled,
    publicOrigin,
    authorizedCallbackDomain: new URL(publicOrigin).hostname,
    callbackUrl: plan.connector ? callbackUrl(plan.connector.id) : null,
    scope: config.scope,
    requiresPhoneOrPasswordForWechat: false,
    automaticAccountLinking: false,
    accountCenterUrl: new URL('/account/security', publicOrigin).toString(),
    callbackDomainConfirmed: Boolean(env.WECHAT_WEB_CALLBACK_DOMAIN?.trim()),
  };
  if (!options.apply) return summary;
  if (!plan.factoryInstalled) throw new Error("WeChat Web connector is not installed in this Logto runtime.");
  // Local preparation is useful before public-domain integration. Non-loopback
  // activation requires an explicit callback-domain match to prevent mistakes.
  const hostname = new URL(publicOrigin).hostname;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname) && !summary.callbackDomainConfirmed) {
    throw new Error("WeChat public activation requires WECHAT_WEB_CALLBACK_DOMAIN matching the approved domain.");
  }
  const savedConnector = await request(plan.connector ? `/api/connectors/${encodeURIComponent(plan.connector.id)}` : '/api/connectors', plan.connector ? 'PATCH' : 'POST', {
    ...(plan.connector ? {} : { connectorId: wechatFactoryId }),
    config,
    // Only seed the Logto profile initially; preserve user changes on later login.
    syncProfile: false,
  });
  if (!isRecord(savedConnector) || typeof savedConnector.id !== 'string' || !savedConnector.id) throw new Error("WeChat connector write returned an invalid response.");

  const freshCenter = await request('/api/account-center');
  if (!isDeepStrictEqual(freshCenter, accountCenter)) throw new Error("WeChat account-center settings changed during preparation; preview again.");
  await request('/api/account-center', 'PATCH', plan.accountCenterPatch);
  const freshExperience = await request('/api/sign-in-exp');
  if (!isDeepStrictEqual(freshExperience, experience)) throw new Error("WeChat sign-in settings changed during preparation; preview again.");
  await request('/api/sign-in-exp', 'PATCH', plan.experiencePatch);

  const [savedExperience, savedCenter, verifiedConnector] = await Promise.all([
    request('/api/sign-in-exp'), request('/api/account-center'), request(`/api/connectors/${encodeURIComponent(savedConnector.id)}`),
  ]);
  if (Object.entries(plan.experiencePatch).some(([key, value]) => !isDeepStrictEqual(savedExperience[key], value))
    || savedCenter.enabled !== true || !isDeepStrictEqual(savedCenter.fields, plan.accountCenterPatch.fields)
    || verifiedConnector.connectorId !== wechatFactoryId || !isDeepStrictEqual(verifiedConnector.config, config) || verifiedConnector.syncProfile !== false) {
    throw new Error("WeChat configuration read-back mismatch; inspect Logto before retrying.");
  }
  return { ...summary, applied: true, callbackUrl: callbackUrl(savedConnector.id) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await configureWechatAuth(parseWechatArgs(process.argv.slice(2)), process.env), null, 2));
  } catch (error) {
    // Never echo SDK, OAuth or HTTP response bodies containing credentials.
    const known = error instanceof Error && /^(WeChat |Usage:|Logto )/u.test(error.message);
    console.error(known ? error.message : 'WeChat configuration failed; check private settings and connectivity.');
    process.exitCode = 1;
  }
}
