// Runs against pinned Logto with --network none. Credentials/messages are synthetic.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadConnector} from '/etc/logto/packages/cli/lib/connector/loader.js';
import {parseMetadata,validateConnectorModule} from '/etc/logto/packages/cli/lib/connector/utils.js';
import {AccountCenters,SignInExperiences} from '/etc/logto/packages/schemas/lib/index.js';
import {unifiedPatch} from '../logto-unified-auth.mjs';
const directory='/etc/logto/packages/core/connectors/@delegate-connector-tencent-ses';
const factory=await loadConnector(directory,false);
const config={secretId:'synthetic-id',secretKey:'synthetic-key',region:'ap-guangzhou',fromEmail:'noreply@example.com',templateId:1001,codeVariable:'code',subject:'Delegate verification'};
const connector=await factory({getConfig:async()=>config});
test('pinned Logto loads and validates Tencent SES metadata/config',async()=>{
 validateConnectorModule(connector);assert.equal(connector.type,'Email');connector.configGuard.parse(config);
 const metadata=await parseMetadata(connector.metadata,directory);assert.equal(metadata.id,'delegate-tencent-ses');assert.match(metadata.logo,/^data:image\/svg\+xml;base64,/u);
});
test('native connector forwards email binding OTP to SES and propagates failures',async()=>{
 const original=globalThis.fetch;let sent;
 try{
  globalThis.fetch=async(url,init)=>{sent={url,body:JSON.parse(init.body)};return Response.json({Response:{MessageId:'synthetic-message'}});};
  await connector.sendMessage({to:'person@example.com',type:'BindNewIdentifier',payload:{code:'123456'}});
  assert.equal(sent.url,'https://ses.tencentcloudapi.com/');assert.equal(sent.body.Template.TemplateData,'{"code":"123456"}');
  globalThis.fetch=async()=>Response.json({Response:{Error:{Code:'FailedOperation.TemplateStatusNotApproved'}}});
  await assert.rejects(connector.sendMessage({to:'person@example.com',type:'BindNewIdentifier',payload:{code:'123456'}}),/TemplateStatusNotApproved/u);
 }finally{globalThis.fetch=original;}
});
test('phone/email-only policy and email binding controls match actual schemas',()=>{
 const patch=unifiedPatch({},true);SignInExperiences.createGuard.partial().parse(patch);
 assert.deepEqual(patch.signIn.methods.map(({identifier})=>identifier),['phone','email']);
 AccountCenters.createGuard.partial().parse({enabled:true,fields:{phone:'Edit',email:'Edit',password:'Edit',social:'Edit'}});
});
