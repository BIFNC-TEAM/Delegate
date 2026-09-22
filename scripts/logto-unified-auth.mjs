import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createManagementClient } from './logto-phone-auth.mjs';
import { mockSmsConfig } from './auth-mock-sms.mjs';

export function assertLocalMock(env) {
  mockSmsConfig(env);
}
export function unifiedPatch(current, emailEnabled = false) {
  return {
    signUp: { identifiers: ['phone'], verify: true, password: false, secondaryIdentifiers: [] },
    signIn: { methods: [
      { identifier: 'phone', password: true, verificationCode: true, isPasswordPrimary: false },
      ...(emailEnabled ? [{ identifier: 'email', password: true, verificationCode: true, isPasswordPrimary: true }] : []),
    ] },
    socialSignIn: { ...current.socialSignIn, skipRequiredIdentifiers: true, automaticAccountLinking: false },
    signUpProfileFields: [],
    forgotPasswordMethods: ['PhoneVerificationCode', ...(emailEnabled ? ['EmailVerificationCode'] : [])],
    passwordPolicy: { ...current.passwordPolicy, length: { min: Math.max(8, current.passwordPolicy?.length?.min || 0), max: Math.min(128, current.passwordPolicy?.length?.max || 128) }, characterTypes: { min: Math.max(3, current.passwordPolicy?.characterTypes?.min || 0) } },
    verificationCodePolicy: { ...current.verificationCodePolicy, expirationDuration: Math.min(300, current.verificationCodePolicy?.expirationDuration || 300), maxRetryAttempts: Math.min(5, current.verificationCodePolicy?.maxRetryAttempts || 5) },
  };
}
export function loginRestartUrl(dashboardUrl, issuer) {
  const target = new URL(dashboardUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'];
  if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && local.includes(target.hostname) && local.includes(new URL(issuer).hostname)))
    || target.username || target.password || target.search || target.hash || target.pathname !== '/' || target.origin === new URL(issuer).origin) {
    throw new Error('NEXT_PUBLIC_DASHBOARD_URL must be a separate trusted application origin for login recovery.');
  }
  return new URL('/auth/login', target).toString();
}
export async function configureUnifiedAuth(env, { apply = false, mock = false } = {}, request = createManagementClient(env)) {
  if (mock) assertLocalMock(env);
  const [current, center, connectors, fields, discovery] = await Promise.all([
    request('/api/sign-in-exp'),request('/api/account-center'),request('/api/connectors'),request('/api/custom-profile-fields'),request('/oidc/.well-known/openid-configuration'),
  ]);
  if (discovery.issuer !== new URL('/oidc', env.LOGTO_ENDPOINT).toString()) throw new Error('Issuer mismatch.');
  if (!Array.isArray(connectors) || !Array.isArray(fields)) throw new Error('Invalid Logto configuration.');
  if (!current?.signIn || !center?.fields) throw new Error('Invalid sign-in or account-center response.');
  if (current.captchaPolicy?.enabled) throw new Error('Integrate the configured CAPTCHA provider before activating this custom experience.');
  if (fields.some((field) => field.name === 'name' && field.type !== 'Text')) throw new Error('Review the existing nickname field type before changing it.');
  const sms = connectors.find((c) => c.type === 'Sms');
  if (!mock && (!sms || sms.connectorId === 'http-sms')) throw new Error('Configure the real mainland SMS connector before real-mode activation.');
  if (mock && sms && !['http-sms','delegate-tencent-sms-cn'].includes(sms.connectorId)) throw new Error('Unexpected SMS connector; refusing to replace it.');
  const emailEnabled = connectors.some((c) => c.type === 'Email');
  const patch = unifiedPatch(current, emailEnabled);
  if (!connectors.some((c) => c.type === 'Email') && current.signIn?.methods?.some((m) => m.identifier === 'email')) throw new Error('An email connector is required to preserve existing email sign-in with optional registration passwords.');
  const ses = connectors.find((c) => c.connectorId === 'delegate-tencent-ses' && c.type === 'Email');
  if (ses && ses.config?.expireMinutes !== patch.verificationCodePolicy.expirationDuration / 60) throw new Error('SES template expiration does not match the planned verification policy; align the policy and rerun SES configuration first.');
  if (env.NEXT_PUBLIC_DASHBOARD_URL) patch.unknownSessionRedirectUrl = loginRestartUrl(env.NEXT_PUBLIC_DASHBOARD_URL, env.LOGTO_ENDPOINT);
  const account = { enabled: true, fields: { ...center.fields, phone: 'Edit', email: emailEnabled ? 'Edit' : 'ReadOnly', password: 'Edit', social: 'Edit', name: 'ReadOnly', avatar: 'Edit' } };
  if (!apply) return { mode: mock ? 'LOCAL MOCK 123456' : 'real', applied: false, phoneOneClick: true, optionalProfile: true, emailEnabled, usernameEnabled: false };
  if (mock) {
    const config = { endpoint: 'http://auth-mock-sms:3801/deliver', authorization: `Bearer ${env.AUTH_MOCK_SMS_TOKEN}` };
    if (sms?.connectorId === 'http-sms') await request(`/api/connectors/${sms.id}`, 'PATCH', { config });
    else await request('/api/connectors','POST',{connectorId:'http-sms',config});
  }
  const nameField = fields.find((field) => field.name === 'name');
  const definition = { name:'name',type:'Text',label:'昵称',required:false,config:{minLength:1,maxLength:80} };
  await request(nameField?'/api/custom-profile-fields/name':'/api/custom-profile-fields',nameField?'PUT':'POST',definition);
  await request('/api/account-center','PATCH',account);
  await request('/api/sign-in-exp','PATCH',patch);
  const [saved, savedAccount] = await Promise.all([request('/api/sign-in-exp'), request('/api/account-center')]);
  if (savedAccount.enabled !== true || !isDeepStrictEqual(savedAccount.fields, account.fields)) throw new Error('Account-center configuration read-back mismatch.');
  if(Object.entries(patch).some(([k,v])=>!isDeepStrictEqual(saved[k],v)))throw new Error('Configuration read-back mismatch.');
  return { mode:mock?'LOCAL MOCK 123456':'real',applied:true };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const args=process.argv.slice(2);
  if(args.some(a=>!['--apply','--mock-sms'].includes(a)))throw new Error('Unsupported argument.');
  console.log(JSON.stringify(await configureUnifiedAuth(process.env,{apply:args.includes('--apply'),mock:args.includes('--mock-sms')})));
 }catch(error){console.error(error instanceof Error ? error.message : 'Unified auth configuration failed.');process.exitCode=1;}
}
