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
