import { describe, expect, it, vi } from 'vitest';
import { assertLocalMock, unifiedPatch, configureUnifiedAuth } from '../logto-unified-auth.mjs';
describe('unified auth configuration', () => {
  it('retains stricter password and OTP requirements', () => {
    const patch=unifiedPatch({passwordPolicy:{length:{min:12,max:64},characterTypes:{min:4},rejects:{pwned:true}},verificationCodePolicy:{expirationDuration:120,maxRetryAttempts:3}});
    expect(patch.passwordPolicy).toEqual({length:{min:12,max:64},characterTypes:{min:4},rejects:{pwned:true}});
    expect(patch.verificationCodePolicy).toMatchObject({expirationDuration:120,maxRetryAttempts:3});
    expect(patch.socialSignIn.automaticAccountLinking).toBe(false);
  });
  it('keeps email login only with a working email connector and Logto-required code capability', () => {
    expect(unifiedPatch({}).signIn.methods.map((m:any)=>m.identifier)).toEqual(['phone']);
    expect(unifiedPatch({},true).signIn.methods.map((m:any)=>m.identifier)).toEqual(['phone','email']);
    expect(unifiedPatch({},true).signIn.methods.find((m:any)=>m.identifier==='email')).toMatchObject({password:true,verificationCode:true});
  });
  it('refuses an SES template expiration that differs from the login policy before mutations', async () => {
    const request=vi.fn(async(path:string)=>{
      if(path==='/api/sign-in-exp')return{signIn:{methods:[]},verificationCodePolicy:{expirationDuration:120}};
      if(path==='/api/account-center')return{fields:{}};
      if(path==='/api/connectors')return[{type:'Sms',connectorId:'delegate-tencent-sms-cn'},{type:'Email',connectorId:'delegate-tencent-ses',config:{expireMinutes:5}}];
      if(path==='/api/custom-profile-fields')return[];
      return{issuer:'http://127.0.0.1:3301/oidc'};
    });
    await expect(configureUnifiedAuth({LOGTO_ENDPOINT:'http://127.0.0.1:3301'},{apply:true},request)).rejects.toThrow('expiration does not match');
    expect(request.mock.calls.every((call)=>call.length===1)).toBe(true);
  });
  it('rejects a public fixed-code issuer before network calls', async () => {
    const request=vi.fn(); await expect(configureUnifiedAuth({LOGTO_ENDPOINT:'https://login.rag8.cn'},{mock:true,apply:true},request)).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
  });
  it('requires explicit local opt-in, token and allowlist', () => {
    expect(()=>assertLocalMock({LOGTO_ENDPOINT:'http://127.0.0.1:3301',NODE_ENV:'development',DELEGATE_AUTH_MOCK_SMS:'true'})).toThrow();
  });
});
