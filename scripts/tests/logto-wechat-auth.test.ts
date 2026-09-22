import { describe, expect, it, vi } from "vitest";
import { buildWechatAuthPlan, configureWechatAuth, parseWechatArgs, readWechatConfig, readWechatPublicOrigin } from "../logto-wechat-auth.mjs";
import { buildPhoneAuthPlan } from "../logto-phone-auth.mjs";

const env = { LOGTO_ENDPOINT: "http://127.0.0.1:3301", WECHAT_WEB_APP_ID: "wx0123456789abcdef", WECHAT_WEB_APP_SECRET: "private-test-secret" };
function fixture(publicOrigin = "http://127.0.0.1:3301") {
  const state = {
    connectors: [],
    factories: [{ id: "wechat-web", type: "Social", platform: "Web" }],
    experience: {
      signIn: { methods: [{ identifier: "username", password: true, verificationCode: false, isPasswordPrimary: true }] },
      signUp: { identifiers: ["username"], verify: false, password: true },
      socialSignIn: {}, socialSignInConnectorTargets: [],
      mfa: { policy: "Mandatory", factors: ["Totp"] }, captchaPolicy: { enabled: true },
    },
    accountCenter: { enabled: false, fields: { phone: "Edit", password: "ReadOnly" } },
  };
  const request = vi.fn(async (path, method = "GET", body) => {
    if (path === "/oidc/.well-known/openid-configuration") return { issuer: `${publicOrigin}/oidc` };
    if (path === '/api/connector-factories') return structuredClone(state.factories);
    if (path === '/api/sign-in-exp') {
      if (method === 'PATCH') Object.assign(state.experience, body);
      return structuredClone(state.experience);
    }
    if (path === '/api/account-center') {
      if (method === 'PATCH') Object.assign(state.accountCenter, body);
      return structuredClone(state.accountCenter);
    }
    if (path === '/api/connectors' && method === 'GET') return structuredClone(state.connectors);
    if (path === '/api/connectors' && method === 'POST') {
      const created = { id: "wechat-instance", target: "wechat", platform: "Web", type: "Social", ...body };
      state.connectors.push(created); return structuredClone(created);
    }
    if (path.startsWith('/api/connectors/')) {
      const row = state.connectors.find((item) => item.id === path.split('/').at(-1));
      if (!row) throw new Error('not found');
      if (method === 'PATCH') Object.assign(row, body);
      return structuredClone(row);
    }
    throw new Error('Unexpected endpoint');
  });
  return { state, request };
}
const writes = (request) => request.mock.calls.filter(([, method]) => method && method !== 'GET');

describe('WeChat hosted registration and sign-in configuration', () => {
  it('uses the website qrconnect scope and rejects invalid/missing credentials', () => {
    expect(readWechatConfig(env)).toEqual({ appId: env.WECHAT_WEB_APP_ID, appSecret: env.WECHAT_WEB_APP_SECRET, scope: 'snsapi_login' });
    expect(() => readWechatConfig({ ...env, WECHAT_WEB_APP_ID: 'mini-program' })).toThrow('AppID');
    expect(() => readWechatConfig({ ...env, WECHAT_WEB_APP_SECRET: '' })).toThrow('AppSecret');
  });
  it('previews without exposing secrets or writing to Logto', async () => {
    const { request } = fixture();
    const result = await configureWechatAuth(parseWechatArgs([]), env, request);
    expect(result).toMatchObject({ applied: false, factoryInstalled: true, scope: 'snsapi_login', requiresPhoneOrPasswordForWechat: false });
    expect(JSON.stringify(result)).not.toContain(env.WECHAT_WEB_APP_SECRET);
    expect(writes(request)).toHaveLength(0);
  });
  it('enables WeChat and explicit binding while preserving password/SMS/MFA/captcha settings', async () => {
    const { state, request } = fixture();
    const before = structuredClone(state.experience);
    const result = await configureWechatAuth({ apply: true }, env, request);
    expect(result).toMatchObject({ applied: true, callbackUrl: 'http://127.0.0.1:3301/callback/wechat-instance' });
    expect(state.experience.signIn).toEqual(before.signIn);
    expect(state.experience.signUp).toEqual(before.signUp);
    expect(state.experience.mfa).toEqual(before.mfa);
    expect(state.experience.captchaPolicy).toEqual(before.captchaPolicy);
    expect(state.experience.socialSignIn).toEqual({ skipRequiredIdentifiers: true, automaticAccountLinking: false });
    expect(state.accountCenter).toEqual({ enabled: true, fields: { phone: 'Edit', password: 'ReadOnly', email: 'ReadOnly', social: 'Edit' } });
    expect(state.connectors[0].syncProfile).toBe(false);
  });
  it('exposes existing verification methods read-only instead of blocking password-only users', () => {
    const { state } = fixture();
    state.accountCenter.fields = { password: 'Off', email: 'Off', phone: 'Off', name: 'Off' };
    expect(buildWechatAuthPlan(state, readWechatConfig(env)).accountCenterPatch.fields).toEqual({
      password: 'ReadOnly', email: 'ReadOnly', phone: 'ReadOnly', name: 'Off', social: 'Edit',
    });
  });
  it('updates the same connector on repeated apply without duplicating targets or identities', async () => {
    const { state, request } = fixture();
    await configureWechatAuth({ apply: true }, env, request);
    await configureWechatAuth({ apply: true }, env, request);
    expect(state.connectors).toHaveLength(1);
    expect(state.experience.socialSignInConnectorTargets).toEqual(['wechat']);
    expect(request.mock.calls.some(([path]) => path.startsWith('/api/users'))).toBe(false);
  });
  it('allows explicit secret rotation for the same AppID but refuses replacing AppID', async () => {
    const { state, request } = fixture();
    await configureWechatAuth({ apply: true }, env, request);
    await configureWechatAuth({ apply: true }, { ...env, WECHAT_WEB_APP_SECRET: 'new-private-secret' }, request);
    expect(state.connectors[0].config.appSecret).toBe('new-private-secret');
    request.mockClear();
    await expect(configureWechatAuth({ apply: true }, { ...env, WECHAT_WEB_APP_ID: 'wxabcdef0123456789' }, request)).rejects.toThrow('identity migration');
    expect(writes(request)).toHaveLength(0);
  });
  it('does not relax another social provider enrollment policy implicitly', () => {
    const { state } = fixture();
    state.experience.socialSignInConnectorTargets = ['google'];
    expect(() => buildWechatAuthPlan(state, readWechatConfig(env))).toThrow('other social providers');
    state.experience.socialSignIn = { skipRequiredIdentifiers: true, automaticAccountLinking: false };
    expect(buildWechatAuthPlan(state, readWechatConfig(env)).experiencePatch.socialSignInConnectorTargets).toEqual(['google', 'wechat']);
  });
  it('checks the public callback domain before making any mutation', async () => {
    const { request } = fixture("https://login.example.com");
    const publicEnv = { ...env, LOGTO_ENDPOINT: 'https://login.example.com' };
    await expect(configureWechatAuth({ apply: true }, publicEnv, request)).rejects.toThrow('WECHAT_WEB_CALLBACK_DOMAIN');
    expect(writes(request)).toHaveLength(0);
    expect(() => readWechatPublicOrigin({ ...publicEnv, WECHAT_WEB_CALLBACK_DOMAIN: 'other.example.com' })).toThrow('does not match');
    expect(() => readWechatPublicOrigin({ ...publicEnv, WECHAT_WEB_CALLBACK_DOMAIN: 'https://login.example.com' })).toThrow('does not match');
    expect(await configureWechatAuth({ apply: true }, { ...publicEnv, WECHAT_WEB_CALLBACK_DOMAIN: 'login.example.com' }, request)).toMatchObject({ applied: true });
  });
  it('refuses a backchannel pointing at a different issuer before writing credentials', async () => {
    const { request } = fixture();
    await expect(configureWechatAuth({ apply: true }, { ...env, LOGTO_ENDPOINT: 'https://login.example.com', WECHAT_WEB_CALLBACK_DOMAIN: 'login.example.com' }, request)).rejects.toThrow('target issuer');
    expect(writes(request)).toHaveLength(0);
  });
  it('refuses unsafe public origins and unsupported CLI arguments', () => {
    for (const origin of ['https://user:secret@auth.example.com', 'https://auth.example.com/path', 'file:///tmp/example', 'http://login.example.com']) {
      expect(() => readWechatPublicOrigin({ LOGTO_ENDPOINT: origin })).toThrow();
    }
    for (const args of [['--force'], ['--apply', '--apply'], ['--delete']]) expect(() => parseWechatArgs(args)).toThrow('Usage');
  });
  it('refuses absent factories and ambiguous Web connectors without writes', async () => {
    const { state, request } = fixture();
    state.factories = [];
    await expect(configureWechatAuth({ apply: true }, env, request)).rejects.toThrow('not installed');
    expect(writes(request)).toHaveLength(0);
    state.connectors = [{ id: 'other', connectorId: 'custom-wechat', target: 'wechat', platform: 'Web' }];
    expect(() => buildWechatAuthPlan(state, readWechatConfig(env))).toThrow('already owned');
  });
  it('reports partial failures without enabling the login button', async () => {
    const f = fixture();
    const request = vi.fn(async (path, method, body) => {
      if (path === '/api/account-center' && method === 'PATCH') throw new Error('service unavailable');
      return f.request(path, method, body);
    });
    await expect(configureWechatAuth({ apply: true }, env, request)).rejects.toThrow('service unavailable');
    expect(f.state.experience.socialSignInConnectorTargets).toEqual([]);
  });
  it('detects concurrent policy edits and read-back failures', async () => {
    const f = fixture();
    const request = async (path, method, body) => {
      if (path === '/api/account-center' && method === 'PATCH') f.state.experience.socialSignInConnectorTargets = ['new-provider'];
      return f.request(path, method, body);
    };
    await expect(configureWechatAuth({ apply: true }, env, request)).rejects.toThrow('changed during preparation');
    expect(f.state.experience.socialSignInConnectorTargets).toEqual(['new-provider']);
    const g = fixture();
    const brokenRequest = async (path, method, body) => path === '/api/sign-in-exp' && method === 'PATCH' ? {} : g.request(path, method, body);
    await expect(configureWechatAuth({ apply: true }, env, brokenRequest)).rejects.toThrow('read-back mismatch');
  });
  it('fails on malformed responses instead of interpreting them as an empty configuration', () => {
    const { state } = fixture();
    expect(() => buildWechatAuthPlan({ ...state, connectors: {} }, readWechatConfig(env))).toThrow('invalid Logto response');
    expect(() => buildWechatAuthPlan({ ...state, accountCenter: null }, readWechatConfig(env))).toThrow('invalid Logto response');
  });
  it('keeps WeChat SMS-independent when phone-code configuration is applied later', async () => {
    const { state, request } = fixture();
    await configureWechatAuth({ apply: true }, env, request);
    const phonePlan = buildPhoneAuthPlan({ ...state, fields: [], users: [] });
    Object.assign(state.experience, phonePlan.patch);
    expect(state.experience.signUp.identifiers).toEqual(['phone']);
    expect(state.experience.socialSignIn).toEqual({ skipRequiredIdentifiers: true, automaticAccountLinking: false });
    expect(state.experience.socialSignInConnectorTargets).toEqual(['wechat']);
    expect(phonePlan.accountCenterPatch.fields.social).toBe('Edit');
  });
});
