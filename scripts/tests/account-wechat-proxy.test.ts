import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockSmsServer, mockSmsConfig } from '../auth-mock-sms.mjs';
const config = mockSmsConfig({ NODE_ENV:'development',DELEGATE_AUTH_MOCK_SMS:'true',LOGTO_ENDPOINT:'http://127.0.0.1:3301',AUTH_MOCK_SMS_TOKEN:'a-synthetic-token-with-at-least-32-characters',WECHAT_WEB_CALLBACK_DOMAIN:'login.rag8.cn',DELEGATE_AUTH_WECHAT_LOCAL_CALLBACK_URI:'https://login.rag8.cn/_delegate/local-wechat/connector' });
let upstream: Server; let proxy: Server; let base: string;
let observed: { path?: string; authorization?: string; verification?: string; body: any };
beforeAll(async () => {
  upstream=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    observed={path:req.url,authorization:req.headers.authorization,verification:req.headers['logto-verification-id'] as string,body:JSON.parse(raw||'{}')};
    if(!req.headers.authorization){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'auth.unauthorized'}));return;}
    res.writeHead(201,{'Content-Type':'application/json'});res.end(JSON.stringify({verificationRecordId:'server-proof',authorizationUri:'https://provider.test/?redirect_uri='+encodeURIComponent(observed.body.redirectUri||'')}));
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  proxy=createMockSmsServer(config,{hostname:'127.0.0.1',port:(upstream.address() as AddressInfo).port});
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');base='http://127.0.0.1:'+(proxy.address() as AddressInfo).port;
});
afterAll(async()=>{for(const server of [proxy,upstream])if(server){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}});
const body={connectorId:'connector',redirectUri:'http://127.0.0.1:3301/account/callback/social/connector',state:'synthetic-state'};
const headers={origin:config.origin,'content-type':'application/json',authorization:'Bearer synthetic-user-token','logto-verification-id':'existing-step-up-proof'};
describe('Account Center proxy HTTP boundary',()=>{
  it('forwards authentication and step-up headers unchanged, rewriting only the callback URI',async()=>{
    const response=await fetch(base+'/api/verifications/social',{method:'POST',headers,body:JSON.stringify(body)});
    expect(response.status).toBe(201);expect(observed).toMatchObject({authorization:headers.authorization,verification:headers['logto-verification-id'],body:{...body,redirectUri:config.wechat.callbackUri}});
    const result=await response.json();expect(result.verificationRecordId).toBe('server-proof');expect(new URL(result.authorizationUri).searchParams.get('redirect_uri')).toBe(config.wechat.callbackUri);
  });
  it('maps an unrestricted mainland Account Center code while preserving verification proof and authentication',async()=>{
    const phone='8619900000456';
    const delivery=await fetch(base+'/deliver',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${config.secret}`},body:JSON.stringify({to:phone,type:'BindNewIdentifier',payload:{code:'928371'}})});
    expect(delivery.status).toBe(200);
    const verification={identifier:{type:'phone',value:phone},verificationRecordId:'native-record',code:'123456'};
    const response=await fetch(base+'/api/verifications/verification-code/verify',{method:'POST',headers,body:JSON.stringify(verification)});
    expect(response.status).toBe(201);
    expect(observed).toMatchObject({authorization:headers.authorization,verification:headers['logto-verification-id'],body:{...verification,code:'928371'}});
  });
  it('preserves native authentication rejection',async()=>{
    const response=await fetch(base+'/api/verifications/social',{method:'POST',headers:{origin:config.origin,'content-type':'application/json'},body:JSON.stringify(body)});
    expect(response.status).toBe(401);expect(await response.json()).toEqual({code:'auth.unauthorized'});
  });
  it('rejects foreign origins and invalid JSON before forwarding',async()=>{
    expect((await fetch(base+'/api/verifications/social',{method:'POST',headers:{...headers,origin:'https://evil.test'},body:JSON.stringify(body)})).status).toBe(403);
    expect((await fetch(base+'/api/verifications/social',{method:'POST',headers,body:'{'})).status).toBe(400);
  });
  it('returns a non-cacheable fixed local redirect without consuming or changing OAuth proof',async()=>{
    const response=await fetch(base+'/callback/connector?delegate_flow=account&code=synthetic-code&state=synthetic-state',{redirect:'manual'});
    expect(response.status).toBe(302);expect(response.headers.get('location')).toBe('http://127.0.0.1:3301/account/callback/social/connector?code=synthetic-code&state=synthetic-state');
    expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
