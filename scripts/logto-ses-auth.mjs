import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createManagementClient } from './logto-phone-auth.mjs';
import { connectorId, validateSesConfig } from '../deploy/logto/connectors/connector-tencent-ses/lib/ses.js';
export function readSesConfig(env) {
  const required = ['TENCENT_SES_SECRET_ID','TENCENT_SES_SECRET_KEY','TENCENT_SES_FROM_EMAIL','TENCENT_SES_TEMPLATE_ID'];
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`Missing SES settings: ${missing.join(', ')}`);
  return validateSesConfig({ secretId:env.TENCENT_SES_SECRET_ID.trim(), secretKey:env.TENCENT_SES_SECRET_KEY.trim(),
    region:env.TENCENT_SES_REGION?.trim() || 'ap-guangzhou', fromEmail:env.TENCENT_SES_FROM_EMAIL.trim(), templateId:Number(env.TENCENT_SES_TEMPLATE_ID),
    codeVariable:env.TENCENT_SES_CODE_VARIABLE?.trim() || 'code', subject:env.TENCENT_SES_SUBJECT?.trim() || 'Delegate 邮箱验证码' });
}
export async function configureSesAuth(env, { apply = false, backup } = {}, request = createManagementClient(env)) {
  const config = readSesConfig(env);
  const [connectors, factories, discovery] = await Promise.all([request('/api/connectors'),request('/api/connector-factories'),request('/oidc/.well-known/openid-configuration')]);
  if (discovery?.issuer !== new URL('/oidc',env.LOGTO_ENDPOINT).toString()) throw new Error('SES target issuer mismatch.');
  if (!Array.isArray(connectors) || !Array.isArray(factories)) throw new Error('Invalid Logto connector response.');
  const emails = connectors.filter((entry) => entry.type === 'Email');
  if (emails.length > 1 || emails.some((entry) => entry.connectorId !== connectorId)) throw new Error('An existing email provider requires an explicit migration; refusing to overwrite it.');
  const available = factories.some((entry) => entry.id === connectorId && entry.type === 'Email');
  if (!available) throw new Error('Install the Tencent SES connector in the pinned Logto runtime first.');
  if (!apply) return {applied:false,provider:connectorId,region:config.region,templateConfigured:true};
  if (backup) await backup({connectors});
  const existing=emails[0];
  const saved=await request(existing?`/api/connectors/${existing.id}`:'/api/connectors',existing?'PATCH':'POST',{...(existing?{}:{connectorId}),config});
  if (!saved?.id) throw new Error('Invalid SES connector write response.');
  const verified=await request(`/api/connectors/${saved.id}`);
  if (verified.connectorId!==connectorId || !isDeepStrictEqual(verified.config,config)) throw new Error('SES configuration read-back mismatch.');
  return {applied:true,provider:connectorId,region:config.region,templateConfigured:true};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try {
    const args=process.argv.slice(2);if(args.some((arg)=>arg!=='--apply')||args.length>1)throw new Error('Usage: logto-ses-auth.mjs [--apply]');
    console.log(JSON.stringify(await configureSesAuth(process.env,{apply:args.includes('--apply'),backup:async(snapshot)=>{
      await mkdir('.local/logto',{recursive:true});
      await writeFile(`.local/logto/ses-before-${Date.now()}.json`,JSON.stringify(snapshot),{mode:0o600});
    }})));
  }catch(error){console.error(error instanceof Error ? error.message : 'SES configuration failed.');process.exitCode=1;}
}
