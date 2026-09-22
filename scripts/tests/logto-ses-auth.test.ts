import { describe, expect, it, vi } from 'vitest';
import { createSesRequest, sendSesVerification } from '../../deploy/logto/connectors/connector-tencent-ses/lib/ses.js';
import { configureSesAuth, readSesConfig } from '../logto-ses-auth.mjs';
const config={secretId:'AKIDEXAMPLE',secretKey:'SECRETEXAMPLE',region:'ap-guangzhou',fromEmail:'noreply@example.com',templateId:1001,codeVariable:'code',expireMinutes:5,subject:'Delegate verification'};
const message={to:'person@example.com',type:'BindNewIdentifier',payload:{code:'123456'}};
describe('Tencent SES email verification',()=>{
 it('matches an independently computed TC3 signature and sends the code and policy expiration to the approved template',()=>{
  const request=createSesRequest(message,config,1700000000);
  expect(request.headers.Authorization).toBe('TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2023-11-14/ses/tc3_request, SignedHeaders=content-type;host, Signature=a60f34a9ebdeb59d23cfc03b01a3f3695e230c3b8ede807c9018ae699c688cef');
  expect(JSON.parse(request.body)).toEqual({FromEmailAddress:config.fromEmail,Destination:[message.to],Subject:config.subject,Template:{TemplateID:1001,TemplateData:'{"code":"123456","expireMinutes":5}'}});
 });
 it.each([{to:'first@example.com,second@example.com'},{to:'evil\r\nBcc: other@example.com'},{payload:{code:'123'}},{type:'OrganizationInvitation'}])('rejects unsupported verification messages before network access',async(change)=>{
  const request=vi.fn();await expect(sendSesVerification({...message,...change},config,request)).rejects.toThrow('InvalidVerificationMessage');expect(request).not.toHaveBeenCalled();
 });
 it.each([{expireMinutes:0},{expireMinutes:NaN},{expireMinutes:61},{codeVariable:'expireMinutes'}])('rejects invalid expiration or colliding template variables before sending',async(change)=>{
  const request=vi.fn();await expect(sendSesVerification(message,{...config,...change},request)).rejects.toThrow('InvalidConfiguration');expect(request).not.toHaveBeenCalled();
 });
 it('accepts only a valid SES success and disables redirects',async()=>{
  const request=vi.fn(async()=>Response.json({Response:{MessageId:'message-id',RequestId:'request-id'}}));
  await expect(sendSesVerification(message,config,request)).resolves.toEqual({messageId:'message-id'});
  expect(request).toHaveBeenCalledWith('https://ses.tencentcloudapi.com/',expect.objectContaining({method:'POST',redirect:'error'}));
 });
 it('does not hide provider errors, expose raw personal details, or retry uncertain sends',async()=>{
  const request=vi.fn(async()=>Response.json({Response:{Error:{Code:'FailedOperation.TemplateStatusNotApproved',Message:'secret recipient person@example.com code 123456'},RequestId:'request-id'}}));
  await expect(sendSesVerification(message,config,request)).rejects.toThrow('FailedOperation.TemplateStatusNotApproved');expect(request).toHaveBeenCalledTimes(1);
  try{await sendSesVerification(message,config,request);}catch(error){expect(String(error)).not.toMatch(/person@|123456|SECRETEXAMPLE/);}
  const network=vi.fn(async()=>{throw new Error('sensitive request body');});await expect(sendSesVerification(message,config,network)).rejects.toThrow('NetworkOrTimeout');expect(network).toHaveBeenCalledTimes(1);
 });
 it.each([{}, {Response:{}}, {Response:{MessageId:''}}])('rejects malformed success responses',async(payload)=>{
  await expect(sendSesVerification(message,config,async()=>Response.json(payload))).rejects.toThrow('InvalidResponse');
 });
 it('requires explicit SES credentials, verified sender and template configuration',()=>{
  expect(()=>readSesConfig({})).toThrow('Missing SES settings');
  expect(readSesConfig({TENCENT_SES_SECRET_ID:'id',TENCENT_SES_SECRET_KEY:'key',TENCENT_SES_FROM_EMAIL:'noreply@example.com',TENCENT_SES_TEMPLATE_ID:'1001'})).toMatchObject({region:'ap-guangzhou',templateId:1001,codeVariable:'code'});
 });
 it.each([300,90])('backs up SES and derives template expiration from the %s-second native policy',async(duration)=>{
  const env={LOGTO_ENDPOINT:'http://127.0.0.1:3301',TENCENT_SES_SECRET_ID:'id',TENCENT_SES_SECRET_KEY:'key',TENCENT_SES_FROM_EMAIL:'noreply@example.com',TENCENT_SES_TEMPLATE_ID:'1001'};
  const backup=vi.fn();const savedConfig=readSesConfig(env,duration);
  const request=vi.fn(async(path:string,method?:string)=>{
   if(path==='/api/connectors' && method==='POST'){expect(backup).toHaveBeenCalledOnce();return{id:'ses-connector'};}
   if(path==='/api/connectors')return[];
   if(path==='/api/connector-factories')return[{id:'delegate-tencent-ses',type:'Email'}];
   if(path==='/api/connectors/ses-connector')return{connectorId:'delegate-tencent-ses',config:savedConfig};
   if(path==='/api/sign-in-exp')return{verificationCodePolicy:{expirationDuration:duration}};
   return{issuer:'http://127.0.0.1:3301/oidc'};
  });
  const result=await configureSesAuth(env,{apply:true,backup},request);
  expect(result).toEqual({applied:true,provider:'delegate-tencent-ses',region:'ap-guangzhou',templateConfigured:true});
  expect(JSON.stringify(result)).not.toContain('secretKey');
 });
 it('refuses to configure a template with an unknown native expiration policy',async()=>{
  const request=vi.fn(async(path:string)=>path==='/api/connectors'?[]:path==='/api/connector-factories'?[{id:'delegate-tencent-ses',type:'Email'}]:path==='/api/sign-in-exp'?{}:{issuer:'http://127.0.0.1:3301/oidc'});
  await expect(configureSesAuth({LOGTO_ENDPOINT:'http://127.0.0.1:3301',TENCENT_SES_SECRET_ID:'id',TENCENT_SES_SECRET_KEY:'key',TENCENT_SES_FROM_EMAIL:'noreply@example.com',TENCENT_SES_TEMPLATE_ID:'1001'},{apply:true},request)).rejects.toThrow('Explicit Logto verification-code expiration');
  expect(request.mock.calls.every((call)=>call.length===1)).toBe(true);
 });
 it('refuses to overwrite an unrelated configured email provider',async()=>{
  const request=vi.fn(async(path:string,method?:string)=>path==='/api/connectors'?[{type:'Email',connectorId:'other',id:'existing'}]:path==='/api/connector-factories'?[]:path==='/api/sign-in-exp'?{verificationCodePolicy:{expirationDuration:300}}:{issuer:'http://127.0.0.1:3301/oidc'});
  await expect(configureSesAuth({LOGTO_ENDPOINT:'http://127.0.0.1:3301',TENCENT_SES_SECRET_ID:'id',TENCENT_SES_SECRET_KEY:'key',TENCENT_SES_FROM_EMAIL:'noreply@example.com',TENCENT_SES_TEMPLATE_ID:'1001'},{apply:true},request)).rejects.toThrow('refusing to overwrite');
  expect(request.mock.calls.every(([,method])=>method===undefined)).toBe(true);
 });
});
