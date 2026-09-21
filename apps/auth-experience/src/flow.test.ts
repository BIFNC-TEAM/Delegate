import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from 'vitest';
import { AuthError, AuthFlow, identifier, passwordError, readSocialCallback, wechatCallbackUri, type Requester } from './flow';
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

describe('WeChat approved-domain callback routing', () => {
  const relay = 'https://login.rag8.cn/_delegate/local-wechat/connector';
  it('uses the approved public relay for local login and preserves the original callback identity', async () => {
    const {flow,request}=fixture();
    const redirect=wechatCallbackUri('http://127.0.0.1:3301','connector',relay);
    await flow.startWechat('connector','nonce',redirect);
    expect(request).toHaveBeenLastCalledWith('/api/experience/verification/social/connector/authorization-uri','POST',{state:'nonce',redirectUri:relay});
    expect(readSocialCallback(JSON.stringify({connectorId:'connector',verificationId:'proof',state:'nonce',createdAt:1000}),'/callback/connector',new URLSearchParams({code:'test',state:'nonce'}),2000)).toMatchObject({verificationId:'proof'});
  });
  it('leaves public Logto callbacks on their own origin, even when a local relay was configured', () => {
    expect(wechatCallbackUri('https://login.rag8.cn','public-connector',relay)).toBe('https://login.rag8.cn/callback/public-connector');
  });
  it('rejects unconfigured loopback callbacks before sending the user to WeChat', () => {
    expect(()=>wechatCallbackUri('http://127.0.0.1:3301','connector')).toThrow('尚未配置');
    expect(()=>wechatCallbackUri('http://localhost:3301','connector',relay)).toThrow('尚未配置');
  });
  it.each(['http://login.rag8.cn/_delegate/local-wechat/connector','https://user:pass@login.rag8.cn/_delegate/local-wechat/connector','https://login.rag8.cn/_delegate/local-wechat/other','https://login.rag8.cn/_delegate/local-wechat/connector?returnTo=https://evil.test','https://127.0.0.1/_delegate/local-wechat/connector'])('rejects invalid or mismatched relay %s',(uri)=>{
    expect(()=>wechatCallbackUri('http://127.0.0.1:3301','connector',uri)).toThrow();
  });
});

describe('development-only WeChat relay build', () => {
  const cwd=fileURLToPath(new URL('..',import.meta.url));
  const callback='https://login.rag8.cn/_delegate/local-wechat/connector';
  it.each([{NODE_ENV:'production',WECHAT_WEB_CALLBACK_DOMAIN:'login.rag8.cn'},{NODE_ENV:'development',WECHAT_WEB_CALLBACK_DOMAIN:'other.example.com'}])('rejects production or mismatched approved domain', (change) => {
    expect(()=>execFileSync(process.execPath,['build.mjs'],{cwd,stdio:'pipe',env:{...process.env,...change,DELEGATE_AUTH_UI_MOCK_SMS_ORIGIN:'',DELEGATE_AUTH_WECHAT_LOCAL_CALLBACK_URI:callback}})).toThrow();
  });
  it('generates an exact-path 302 relay with a fixed local destination and preserves code/state query', () => {
    const directory=mkdtempSync(join(tmpdir(),'delegate-wechat-build-'));
    try {
      execFileSync(process.execPath,['build.mjs'],{cwd,stdio:'pipe',env:{...process.env,NODE_ENV:'development',WECHAT_WEB_CALLBACK_DOMAIN:'login.rag8.cn',DELEGATE_AUTH_UI_MOCK_SMS_ORIGIN:'',DELEGATE_AUTH_WECHAT_LOCAL_CALLBACK_URI:callback,AUTH_UI_OUTPUT_DIR:directory}});
      const labels=JSON.parse(readFileSync(join(directory,'local-wechat-relay-labels.json'),'utf8'));
      const prefix='traefik.http.middlewares.delegate-local-wechat-redirect.redirectregex';
      const regex=new RegExp(labels[`${prefix}.regex`]);
      expect(callback+'?code=test&state=nonce').toMatch(regex);
      expect(regex.test('https://login.rag8.cn/callback/public?code=test')).toBe(false);
      expect(regex.test(callback+'/other?code=test')).toBe(false);
      expect(labels[`${prefix}.replacement`]).toBe('http://127.0.0.1:3301/callback/connector${1}');
      expect(regex.exec(callback+'?code=test&state=nonce')?.[1]).toBe('?code=test&state=nonce');
      expect(labels[`${prefix}.permanent`]).toBe('false');
      expect(labels['traefik.http.routers.delegate-local-wechat.rule']).toContain('Method(`GET`)');
      const configuredHtml=readFileSync(join(directory,'index.html'),'utf8');
      expect(configuredHtml).toMatch(/delegate-auth\.js\?v=[a-f0-9]{16}/);
      execFileSync(process.execPath,['build.mjs'],{cwd,stdio:'pipe',env:{...process.env,NODE_ENV:'development',DELEGATE_AUTH_UI_MOCK_SMS_ORIGIN:'',DELEGATE_AUTH_WECHAT_LOCAL_CALLBACK_URI:'',AUTH_UI_OUTPUT_DIR:directory}});
      const unconfiguredHtml=readFileSync(join(directory,'index.html'),'utf8');
      expect(unconfiguredHtml.match(/delegate-auth\.js\?v=[a-f0-9]{16}/)?.[0]).not.toBe(configuredHtml.match(/delegate-auth\.js\?v=[a-f0-9]{16}/)?.[0]);
    } finally { rmSync(directory,{recursive:true,force:true}); }
  });
});
