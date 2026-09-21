import { describe, expect, it } from 'vitest';
import { createMockSmsStore, mockSmsConfig } from '../auth-mock-sms.mjs';
const env = { NODE_ENV: 'development', DELEGATE_AUTH_MOCK_SMS: 'true', LOGTO_ENDPOINT: 'http://127.0.0.1:3301', AUTH_MOCK_SMS_TOKEN: 'test-only-token-with-at-least-32-bytes', AUTH_MOCK_SMS_ALLOWED_PHONES: '8613800138000' };
describe('local fixed-code SMS delivery simulation', () => {
  it.each([{ NODE_ENV: 'production' }, { LOGTO_ENDPOINT: 'https://login.rag8.cn' }, { DELEGATE_AUTH_MOCK_SMS: 'false' }, { AUTH_MOCK_SMS_ALLOWED_PHONES: '' }])('refuses unsafe configuration %j', (change) => { expect(() => mockSmsConfig({ ...env, ...change })).toThrow(); });
  it('requires authenticated delivery, allowlisted phone, correct purpose and explicit test code', () => {
    const config = mockSmsConfig(env); const store = createMockSmsStore(config);
    expect(() => store.deliver({ to: '8613800138000', type: 'SignIn', payload: { code: '928371' } }, '')).toThrow();
    store.deliver({ to: '+8613800138000', type: 'SignIn', payload: { code: '928371' } }, `Bearer ${config.secret}`);
    expect(store.resolve({ phone: '8613800138000', type: 'SignIn', testCode: '123456' })).toBe('928371');
    expect(() => store.resolve({ phone: '8613800138000', type: 'ForgotPassword', testCode: '123456' })).toThrow();
    expect(() => store.resolve({ phone: '8613800138000', type: 'SignIn', testCode: '000000' })).toThrow();
    expect(() => store.resolve({ phone: '8613900138000', type: 'SignIn', testCode: '123456' })).toThrow();
  });
  it('maps only allowlisted native Account Center test codes; keeps other codes unchanged', () => {
    const config = mockSmsConfig(env); const store = createMockSmsStore(config);
    store.deliver({ to: '8613800138000', type: 'BindNewIdentifier', payload: { code: '987654' } }, `Bearer ${config.secret}`);
    expect(store.resolveAccountCode({ identifier: { type: 'phone', value: '8613800138000' }, code: '123456' })).toBe('987654');
    expect(store.resolveAccountCode({ identifier: { type: 'phone', value: '8613800138000' }, code: '000000' })).toBe('000000');
    expect(store.resolveAccountCode({ identifier: { type: 'phone', value: '8613900138000' }, code: '123456' })).toBe('123456');
  });
  it('expires captured messages and uses the latest real Logto code after resend', () => {
    let now = 0; const config = mockSmsConfig(env); const store = createMockSmsStore(config, () => now);
    for (const code of ['111111', '222222']) store.deliver({ to: '8613800138000', type: 'SignIn', payload: { code } }, `Bearer ${config.secret}`);
    expect(store.resolve({ phone: '8613800138000', type: 'SignIn', testCode: '123456' })).toBe('222222');
    now = 300_001;
    expect(() => store.resolve({ phone: '8613800138000', type: 'SignIn', testCode: '123456' })).toThrow();
  });
});

describe('native Account Center WeChat callback routing', () => {
  const callback = 'https://login.rag8.cn/_delegate/local-wechat/connector';
  const config = () => mockSmsConfig({ ...env, WECHAT_WEB_CALLBACK_DOMAIN: 'login.rag8.cn', DELEGATE_AUTH_WECHAT_LOCAL_CALLBACK_URI: callback });
  it('rewrites only the configured native account callback and preserves proof fields', async () => {
    const { rewriteAccountWechatRequest } = await import('../auth-mock-sms.mjs');
    const body = { connectorId: 'connector', redirectUri: 'http://127.0.0.1:3301/account/callback/social/connector', state: 'original-state', scope: 'snsapi_login' };
    expect(rewriteAccountWechatRequest(config(), '/api/verifications/social', body)).toEqual({ ...body, redirectUri: callback + '?delegate_flow=account' });
    expect(body.redirectUri).toBe('http://127.0.0.1:3301/account/callback/social/connector');
    const verify = { verificationRecordId: 'original-record', connectorData: { code: 'synthetic-code', state: 'original-state', redirectUri: body.redirectUri } };
    expect(rewriteAccountWechatRequest(config(), '/api/verifications/social/verify', verify)).toEqual({ ...verify, connectorData: { ...verify.connectorData, redirectUri: callback + '?delegate_flow=account' } });
    expect(rewriteAccountWechatRequest(config(), '/api/my-account/identities', { newIdentifierVerificationRecordId: 'proof' })).toEqual({ newIdentifierVerificationRecordId: 'proof' });
    expect(rewriteAccountWechatRequest(config(), '/api/verifications/social', { ...body, connectorId: 'other' })).toEqual({ ...body, connectorId: 'other' });
    expect(() => rewriteAccountWechatRequest(config(), '/api/verifications/social', { ...body, redirectUri: 'https://evil.test' })).toThrow();
  });
  it('routes the marked callback only to the fixed local Account Center path', async () => {
    const { accountWechatCallbackTarget } = await import('../auth-mock-sms.mjs');
    expect(accountWechatCallbackTarget(config(), '/callback/connector?delegate_flow=account&code=test&state=nonce&returnTo=https://evil.test', 'GET')).toBe('http://127.0.0.1:3301/account/callback/social/connector?code=test&state=nonce');
    expect(accountWechatCallbackTarget(config(), '/callback/connector?delegate_flow=account&error=access_denied&state=nonce', 'GET')).toBe('http://127.0.0.1:3301/account/callback/social/connector?state=nonce&error=access_denied');
    for (const path of ['http://[invalid', '/callback/connector?code=test&state=nonce', '/callback/other?delegate_flow=account', '/callback/connector?delegate_flow=account&delegate_flow=other']) expect(accountWechatCallbackTarget(config(), path, 'GET')).toBeNull();
    expect(accountWechatCallbackTarget(config(), '/callback/connector?delegate_flow=account', 'POST')).toBeNull();
  });
  it.each([
    { WECHAT_WEB_CALLBACK_DOMAIN: 'wrong.example.com' },
    { DELEGATE_AUTH_WECHAT_LOCAL_CALLBACK_URI: 'http://login.rag8.cn/_delegate/local-wechat/connector' },
    { DELEGATE_AUTH_WECHAT_LOCAL_CALLBACK_URI: callback + '?returnTo=https://evil.test' },
    { LOGTO_ENDPOINT: 'http://localhost:3301' },
  ])('rejects inconsistent local relay configuration', (change) => {
    expect(() => mockSmsConfig({ ...env, WECHAT_WEB_CALLBACK_DOMAIN: 'login.rag8.cn', DELEGATE_AUTH_WECHAT_LOCAL_CALLBACK_URI: callback, ...change })).toThrow();
  });
});
