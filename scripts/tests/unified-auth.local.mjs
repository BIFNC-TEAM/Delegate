// Opt-in integration test against a backed-up LOCAL Logto with mock SMS enabled.
// Run with Node >= 22.12 and the private env files; never use a real phone here.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createManagementClient } from '../logto-phone-auth.mjs';
import { mockSmsConfig } from '../auth-mock-sms.mjs';
const config = mockSmsConfig(process.env);
const origin = config.origin;
const phone = process.env.AUTH_INTEGRATION_PHONE;
assert(phone && config.phones.has(phone), 'Set an unused allowlisted AUTH_INTEGRATION_PHONE.');
const identifier = { type: 'phone', value: phone };
const app = process.env.LOGTO_DASHBOARD_APP_ID;
assert(app && process.env.NEXT_PUBLIC_DASHBOARD_URL, 'Dashboard OIDC configuration is required.');
const management = createManagementClient({ ...process.env, LOGTO_BACKCHANNEL_ENDPOINT: origin });
const findUser = async () => (await management(`/api/users?search=${encodeURIComponent(phone)}`)).find((user) => user.primaryPhone === phone);
assert(!await findUser(), 'Test phone already has an account; refusing to modify it.');
const jar = new Map();
let createdId;
async function send(path, method = 'GET', body) {
  const response = await fetch(new URL(path, origin), { method, redirect: 'manual', headers: {
    cookie: [...jar].map(([k,v]) => `${k}=${v}`).join('; '), origin, 'Logto-App-Id': app,
    ...(body ? {'content-type':'application/json'} : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  for (const cookie of response.headers.getSetCookie()) { const part = cookie.split(';')[0]; const split = part.indexOf('='); jar.set(part.slice(0,split),part.slice(split+1)); }
  const data = await response.json().catch(() => ({}));
  if (response.status >= 400) throw Object.assign(new Error(`${method} ${new URL(path,origin).pathname}: ${response.status} ${data.code || ''}`), { code: data.code });
  return { data, location: response.headers.get('location'), headers: response.headers };
}
async function start(event = 'SignIn') {
  jar.clear();
  const url = new URL('/oidc/auth',origin);
  url.search = new URLSearchParams({ client_id:app, redirect_uri:new URL('/auth/callback',process.env.NEXT_PUBLIC_DASHBOARD_URL).href, response_type:'code', scope:'openid profile phone', state:randomBytes(16).toString('hex'), nonce:randomBytes(16).toString('hex'), code_challenge:createHash('sha256').update(randomBytes(32)).digest('base64url'), code_challenge_method:'S256', prompt:'login' }).toString();
  let next = url.href;
  for (let i=0;i<8;i++) { const result=await send(next); if(!result.location)break; const destination=new URL(result.location,origin); assert.equal(destination.origin,origin); next=destination.href; }
  await send('/api/experience','PUT',{ interactionEvent:event });
}
async function verify(event = 'SignIn') {
  const challenge=(await send('/api/experience/verification/verification-code','POST',{identifier,interactionEvent:event})).data;
  await assert.rejects(send('/api/experience/verification/verification-code/verify','POST',{identifier,verificationId:challenge.verificationId,code:'wrong-code'}));
  const {code}=(await send('/__delegate_mock_sms/resolve','POST',{phone,type:event,testCode:'123456'})).data;
  return (await send('/api/experience/verification/verification-code/verify','POST',{identifier,verificationId:challenge.verificationId,code})).data.verificationId;
}
try {
  await start(); const proof=await verify();
  await assert.rejects(send('/api/experience/identification','POST',{verificationId:proof}),{code:'user.user_not_exist'});
  assert(!await findUser());
  await send('/api/experience/interaction-event','PUT',{interactionEvent:'Register'});
  await send('/api/experience/identification','POST',{verificationId:proof});
  createdId=(await findUser())?.id; assert(createdId);
  await send('/api/experience/profile','POST',{type:'password',value:'LocalTest826!Ab'});
  await send('/api/experience/profile','POST',{type:'extraProfile',values:{name:'Local auth integration fixture'}});
  assert((await send('/api/experience/submit','POST')).data.redirectTo);
  const user=await management(`/api/users/${createdId}`); assert.equal(user.name,'Local auth integration fixture'); assert.equal(user.hasPassword,true);
  console.log('PASS verified registration, optional password/nickname persistence and OIDC submission');
  await start();
  await assert.rejects(send('/api/experience/identification','POST',{verificationId:proof}));
  await assert.rejects(send('/api/experience/verification/password','POST',{identifier,password:'WrongPassword890!'}));
  const passwordProof=(await send('/api/experience/verification/password','POST',{identifier,password:'LocalTest826!Ab'})).data.verificationId;
  await send('/api/experience/identification','POST',{verificationId:passwordProof});
  assert((await send('/api/experience/submit','POST')).data.redirectTo);
  console.log('PASS existing password sign-in; wrong password and previous-session proof rejected');
  await start('ForgotPassword');const resetProof=await verify('ForgotPassword');
  await send('/api/experience/identification','POST',{verificationId:resetProof});
  await send('/api/experience/profile/password','PUT',{password:'LocalReset927!Ab'});
  await send('/api/experience/submit','POST');
  await start();
  await assert.rejects(send('/api/experience/verification/password','POST',{identifier,password:'LocalTest826!Ab'}));
  const fresh=(await send('/api/experience/verification/password','POST',{identifier,password:'LocalReset927!Ab'})).data.verificationId;
  await send('/api/experience/identification','POST',{verificationId:fresh});
  console.log('PASS verified password reset; old password rejected and new password accepted');
} finally {
  // This ID was created during this test; no pre-existing account is modified/deleted.
  if(createdId) { await management(`/api/users/${createdId}`,'DELETE'); console.log('Cleaned up this run’s local identity fixture.'); }
}
