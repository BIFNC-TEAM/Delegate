import { createHash, createHmac } from 'node:crypto';
export const connectorId = 'delegate-tencent-ses';
export const otpUsages = ['Register', 'SignIn', 'ForgotPassword', 'Generic', 'UserPermissionValidation', 'BindNewIdentifier', 'MfaVerification', 'BindMfa'];
export class TencentSesError extends Error {
  constructor(code, requestId) { super(`Tencent SES request failed (${code}${requestId ? `; request ${requestId}` : ''}).`); this.code = code; }
}
const emailPattern = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/u;
export function validateSesConfig(config) {
  if (!config || typeof config.secretId !== 'string' || !config.secretId.trim() || typeof config.secretKey !== 'string' || !config.secretKey.trim()
    || !['ap-guangzhou', 'ap-hongkong'].includes(config.region) || typeof config.fromEmail !== 'string' || !emailPattern.test(config.fromEmail)
    || !Number.isSafeInteger(config.templateId) || config.templateId <= 0
    || typeof config.codeVariable !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(config.codeVariable)
    || !Number.isFinite(config.expireMinutes) || config.expireMinutes <= 0 || config.expireMinutes > 60
    || config.codeVariable === 'expireMinutes'
    || typeof config.subject !== 'string' || !config.subject.trim() || config.subject.length > 128 || /[\r\n]/u.test(config.subject)) throw new TencentSesError('InvalidConfiguration');
  return config;
}
export function createSesRequest(data, config, timestamp = Math.floor(Date.now() / 1000)) {
  validateSesConfig(config);
  if (!data || typeof data.to !== 'string' || data.to.length > 254 || !emailPattern.test(data.to) || !otpUsages.includes(data.type) || typeof data.payload?.code !== 'string' || !/^\d{6}$/u.test(data.payload.code)) throw new TencentSesError('InvalidVerificationMessage');
  const host = 'ses.tencentcloudapi.com';
  const body = JSON.stringify({ FromEmailAddress: config.fromEmail, Destination: [data.to], Subject: config.subject,
    Template: { TemplateID: config.templateId, TemplateData: JSON.stringify({ [config.codeVariable]: data.payload.code, expireMinutes: config.expireMinutes }) } });
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/ses/tc3_request`;
  const canonical = ['POST', '/', '', `content-type:application/json; charset=utf-8\nhost:${host}\n`, 'content-type;host', hash(body)].join('\n');
  const toSign = ['TC3-HMAC-SHA256', String(timestamp), scope, hash(canonical)].join('\n');
  const signature = hmac(hmac(hmac(hmac(`TC3${config.secretKey}`, date), 'ses'), 'tc3_request'), toSign).toString('hex');
  return { url: `https://${host}/`, body, headers: {
    'Content-Type': 'application/json; charset=utf-8', Host: host,
    Authorization: `TC3-HMAC-SHA256 Credential=${config.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
    'X-TC-Action': 'SendEmail', 'X-TC-Version': '2020-10-02', 'X-TC-Region': config.region, 'X-TC-Timestamp': String(timestamp),
  } };
}
export async function sendSesVerification(data, config, fetchImpl = fetch) {
  const request = createSesRequest(data, config);
  let response;
  try { response = await fetchImpl(request.url, { method: 'POST', headers: request.headers, body: request.body, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new TencentSesError('NetworkOrTimeout'); }
  let result;
  try { result = await response.json(); } catch { throw new TencentSesError('InvalidResponse'); }
  const payload = result?.Response;
  if (!response.ok || payload?.Error) {
    const code = typeof payload?.Error?.Code === 'string' && /^[A-Za-z0-9._]+$/u.test(payload.Error.Code) ? payload.Error.Code : `HTTP_${response.status}`;
    const requestId = typeof payload?.RequestId === 'string' && /^[A-Za-z0-9-]{1,80}$/u.test(payload.RequestId) ? payload.RequestId : undefined;
    // Provider messages can contain email addresses or request details. Return
    // only a bounded error code / request ID, never recipient, code or secrets.
    throw new TencentSesError(code, requestId);
  }
  if (typeof payload?.MessageId !== 'string' || !payload.MessageId) throw new TencentSesError('InvalidResponse');
  return { messageId: payload.MessageId };
}
