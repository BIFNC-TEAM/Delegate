// Real pinned connector, isolated in a --network none container. All identities
// and credentials below are synthetic; this does not prove live WeChat consent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConnector } from '/etc/logto/packages/cli/lib/connector/loader.js';
import { AccountCenters, SignInExperiences } from '/etc/logto/packages/schemas/lib/index.js';
import { ConnectorErrorCodes } from '/etc/logto/packages/core/node_modules/@logto/connector-kit/lib/index.js';
import { got } from '/etc/logto/packages/core/connectors/@logto-connector-wechat-web/node_modules/got/dist/source/index.js';
import { buildWechatAuthPlan, readWechatConfig } from '../logto-wechat-auth.mjs';

const config = readWechatConfig({ WECHAT_WEB_APP_ID: 'wx0123456789abcdef', WECHAT_WEB_APP_SECRET: 'synthetic-secret' });
const factory = await loadConnector('/etc/logto/packages/core/connectors/@logto-connector-wechat-web', false);
const connector = await factory({ getConfig: async () => config });

test('installed WeChat Web connector generates the correct qrconnect flow', async () => {
  const uri = new URL(await connector.getAuthorizationUri({ state: 'synthetic-state', redirectUri: 'https://login.example.com/callback/instance' }));
  assert.equal(uri.origin + uri.pathname, 'https://open.weixin.qq.com/connect/qrconnect');
  assert.equal(uri.searchParams.get('scope'), 'snsapi_login');
  assert.equal(uri.searchParams.get('redirect_uri'), 'https://login.example.com/callback/instance');
  assert.equal(uri.searchParams.get('state'), 'synthetic-state');
  assert.ok(!uri.toString().includes(config.appSecret));
});

test('social enrollment and explicit binding configuration match pinned Logto schemas', () => {
  const plan = buildWechatAuthPlan({ connectors: [], factories: [], experience: { socialSignIn: {}, socialSignInConnectorTargets: [] }, accountCenter: { enabled: false, fields: {} } }, config);
  SignInExperiences.createGuard.partial().parse(plan.experiencePatch);
  AccountCenters.createGuard.partial().parse(plan.accountCenterPatch);
});

test('actual connector maps UnionID and nickname without requiring phone/email', async () => {
  const original = got.get;
  got.get = async (url) => ({ body: JSON.stringify(url.includes('/access_token')
    ? { access_token: 'test-token', openid: 'openid-1' }
    : { unionid: 'unionid-1', nickname: '微信测试用户', headimgurl: 'https://example.com/avatar.png' }) });
  try {
    const user = await connector.getUserInfo({ code: 'synthetic-code' });
    assert.equal(user.id, 'unionid-1');
    assert.equal(user.name, '微信测试用户');
    assert.equal(user.phone, undefined);
    assert.equal(user.email, undefined);
  } finally { got.get = original; }
});

test('actual connector retains the OpenID fallback when UnionID is not supplied', async () => {
  const original = got.get;
  got.get = async (url) => ({ body: JSON.stringify(url.includes('/access_token')
    ? { access_token: 'test-token', openid: 'openid-only' } : { nickname: '微信用户' }) });
  try { assert.equal((await connector.getUserInfo({ code: 'synthetic-code' })).id, 'openid-only'); }
  finally { got.get = original; }
});

test('actual connector rejects invalid/expired codes and network errors', async () => {
  const original = got.get;
  try {
    got.get = async () => ({ body: JSON.stringify({ errcode: 40029, errmsg: 'invalid code' }) });
    await assert.rejects(connector.getUserInfo({ code: 'bad-code' }), (error) => error.code === ConnectorErrorCodes.SocialAuthCodeInvalid);
    got.get = async () => { throw new Error('network unavailable'); };
    await assert.rejects(connector.getUserInfo({ code: 'synthetic-code' }), /network unavailable/);
    await assert.rejects(connector.getUserInfo({}), /./);
  } finally { got.get = original; }
});
