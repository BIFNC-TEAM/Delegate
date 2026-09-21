import { describe, expect, it, vi } from 'vitest';
import { AuthError, AuthFlow, identifier, passwordError, readSocialCallback, type Requester } from './flow';
function fixture(fail?: (path: string, body: any, index: number) => void) {
  let index = 0;
  const request = vi.fn(async (path: string, _method?: string, body?: any) => {
    fail?.(path, body, index++);
    if (path.endsWith('/submit')) return { redirectTo: '/oidc/auth/resume' };
    return { verificationId: body?.verificationId || 'proof', authorizationUri: 'https://open.weixin.qq.com/connect/qrconnect' };
  });
  const navigate = vi.fn(); const flow = new AuthFlow(request as Requester, navigate);
  return { flow, request, navigate };
}
const missing = () => { throw new AuthError('user.user_not_exist', 'not found', 404); };
describe('verified account flows', () => {
  it('registers an unknown verified phone and waits for optional profile before redirect', async () => {
    let first = true;
    const { flow, request, navigate } = fixture((path) => { if (path.endsWith('/identification') && first) { first = false; missing(); } });
    await flow.reset(); await flow.sendCode('13800138000'); await flow.codeLogin('13800138000', '123456');
    expect(flow.state.stage).toBe('onboarding'); expect(navigate).not.toHaveBeenCalled();
    await flow.completeProfile(' 阿江 ', 'Strong789!');
    expect(request).toHaveBeenCalledWith('/api/experience/profile', 'POST', { type: 'extraProfile', values: { name: '阿江' } });
    expect(navigate).toHaveBeenCalledOnce();
  });
  it('skips optional fields without writing blank nickname or password', async () => {
    const { flow, request } = fixture(); await flow.completeProfile('', '', true);
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/experience/submit']);
  });
  it('pauses unknown WeChat before creating an identity or workspace', async () => {
    const { flow, request, navigate } = fixture((path) => { if (path.endsWith('/identification')) missing(); });
    await flow.wechatCallback('wechat', 'social-proof', { code: 'provider-code', state: 'nonce' });
    expect(flow.state.stage).toBe('wechat-choice'); expect(navigate).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([, , body]) => body?.interactionEvent === 'Register')).toBe(false);
  });
  it('links WeChat only after verifying the existing account, preserving the social proof', async () => {
    let first = true;
    const { flow, request } = fixture((path) => { if (path.endsWith('/identification') && first) { first = false; missing(); } });
    await flow.wechatCallback('wechat', 'social-proof', { code: 'provider-code', state: 'nonce' });
    flow.chooseExisting(); await flow.passwordLogin('existing', 'correct-password');
    const calls = request.mock.calls;
    expect(calls.findIndex(([p]) => p.endsWith('/password'))).toBeLessThan(calls.findIndex(([p]) => p === '/api/experience/profile'));
    expect(request).toHaveBeenCalledWith('/api/experience/profile', 'POST', { type: 'social', verificationId: 'social-proof' });
    expect(calls.some(([, , body]) => body?.interactionEvent === 'Register')).toBe(false);
  });
  it.each(['link', 'reset'] as const)('never creates a missing account during %s', async (stage) => {
    const { flow, request } = fixture((path) => { if (path.endsWith('/identification')) missing(); });
    if (stage === 'link') { await flow.wechatCallback('wechat', 'social-proof', { code: 'code', state: 'nonce' }); flow.chooseExisting(); }
    else await flow.reset('reset');
    await flow.sendCode('13800138000');
    await expect(flow.codeLogin('13800138000', '123456')).rejects.toMatchObject({ code: 'user.user_not_exist' });
    expect(request.mock.calls.some(([, , body]) => body?.interactionEvent === 'Register')).toBe(false);
  });
  it('cannot link on a wrong password or overwrite an occupied social identity', async () => {
    let phase = 'social';
    const { flow, navigate } = fixture((path) => {
      if (phase === 'social' && path.endsWith('/identification')) missing();
      if (phase === 'password' && path.endsWith('/password')) throw new AuthError('user.invalid_password', 'bad');
      if (phase === 'conflict' && path.endsWith('/profile')) throw new AuthError('user.identity_already_in_use', 'conflict');
    });
    await flow.wechatCallback('wechat', 'social-proof', { code: 'code', state: 'nonce' }); flow.chooseExisting();
    phase = 'password'; await flow.run(() => flow.passwordLogin('existing', 'wrong')); expect(flow.state.error).toContain('密码不正确');
    phase = 'conflict'; await flow.run(() => flow.passwordLogin('existing', 'right')); expect(flow.state.error).toContain('已关联');
    expect(navigate).not.toHaveBeenCalled();
  });
  it('requires a fresh challenge when the phone changes and rejects resending during cooldown', async () => {
    const { flow, request } = fixture(); await flow.sendCode('13800138000'); const count = request.mock.calls.length;
    await expect(flow.codeLogin('13900138000', '123456')).rejects.toThrow('改变');
    await expect(flow.sendCode('13800138000')).rejects.toThrow('倒计时'); expect(request).toHaveBeenCalledTimes(count);
  });
  it('resets a password only after code verification, then returns to login', async () => {
    const { flow, request, navigate } = fixture(); await flow.reset('reset'); await flow.sendCode('13800138000');
    await flow.codeLogin('13800138000', '123456'); expect(flow.state.stage).toBe('reset-password');
    await flow.resetPassword('NewStrong89!'); expect(flow.state.stage).toBe('reset-success');
    expect(request).toHaveBeenCalledWith('/api/experience/profile/password', 'PUT', { password: 'NewStrong89!' }); expect(navigate).not.toHaveBeenCalled();
  });
  it('surfaces network failures and missing redirect responses without claiming success', async () => {
    const { flow } = fixture(() => { throw new TypeError('network'); });
    await flow.run(() => flow.sendCode('13800138000')); expect(flow.state.error).toContain('网络'); expect(flow.state.busy).toBe(false);
    const navigate = vi.fn(); const invalid = new AuthFlow((async () => ({})) as Requester, navigate);
    await invalid.run(() => invalid.completeProfile('', '', true)); expect(invalid.state.error).not.toBe(''); expect(navigate).not.toHaveBeenCalled();
  });
  it('normalizes mainland phones and enforces password requirements', () => {
    expect(identifier('+8613800138000')).toEqual({ type: 'phone', value: '8613800138000' });
    expect(() => identifier('+14155552671', true)).toThrow();
    expect(passwordError('short')).toBeTruthy(); expect(passwordError('onlylowercase')).toBeTruthy(); expect(passwordError('Example123')).toBeNull();
  });
});

describe('WeChat callback state', () => {
  const saved = {state:'nonce',verificationId:'proof',connectorId:'wechat',createdAt:1000};
  const params = new URLSearchParams({state:'nonce',code:'provider-code'});
  it('accepts only matching, fresh state and connector', () => { expect(readSocialCallback(JSON.stringify(saved),'/callback/wechat',params,2000)).toMatchObject({verificationId:'proof',code:'provider-code'}); });
  it.each([null,'{',JSON.stringify({...saved,state:'wrong'}),JSON.stringify({...saved,createdAt:NaN}),JSON.stringify({...saved,createdAt:3000}),JSON.stringify({...saved,verificationId:''})])('rejects invalid callback state', (raw) => { expect(()=>readSocialCallback(raw,'/callback/wechat',params,2000)).toThrow(); });
  it('rejects expired proofs, a different connector and provider cancellation', () => {
    expect(()=>readSocialCallback(JSON.stringify(saved),'/callback/wechat',params,700000)).toThrow();
    expect(()=>readSocialCallback(JSON.stringify(saved),'/callback/other',params,2000)).toThrow();
    expect(()=>readSocialCallback(JSON.stringify(saved),'/callback/wechat',new URLSearchParams({state:'nonce',error:'cancelled'}),2000)).toThrow('取消');
  });
});
