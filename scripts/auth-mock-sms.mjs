import { createServer, request as httpRequest } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Logto stores mainland numbers as 86 + 11 digits; normalize a single + at ingress.
export const isMainlandMockPhone = (phone) => /^861[3-9]\d{9}$/u.test(String(phone ?? ''));

export function mockSmsConfig(env) {
  const origin = new URL(env.LOGTO_ENDPOINT || '');
  if (env.NODE_ENV !== 'development' || env.DELEGATE_AUTH_MOCK_SMS !== 'true'
    || !['localhost', '127.0.0.1'].includes(origin.hostname) || origin.protocol !== 'http:') {
    throw new Error('Mock SMS requires explicit development mode and a loopback Logto issuer.');
  }
  const secret = env.AUTH_MOCK_SMS_TOKEN || '';
  if (secret.length < 32) throw new Error('Mock delivery token must have at least 32 characters.');
  let wechat;
  if (env.DELEGATE_AUTH_WECHAT_LOCAL_CALLBACK_URI) {
    const callback = new URL(env.DELEGATE_AUTH_WECHAT_LOCAL_CALLBACK_URI);
    const match = /^\/_delegate\/local-wechat\/([A-Za-z0-9_-]+)$/.exec(callback.pathname);
    if (origin.origin !== 'http://127.0.0.1:3301' || callback.protocol !== 'https:' || callback.username || callback.password || callback.port
      || callback.search || callback.hash || !match || ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)
      || callback.hostname !== env.WECHAT_WEB_CALLBACK_DOMAIN) throw new Error('Invalid approved local WeChat callback configuration.');
    callback.searchParams.set('delegate_flow', 'account');
    wechat = { connectorId: match[1], callbackUri: callback.toString(), accountCallback: `${origin.origin}/account/callback/social/${match[1]}` };
  }
  return { origin: origin.origin, secret, wechat };
}
export function createMockSmsStore(config, now = Date.now) {
  const codes = new Map();
  const validTypes = new Set(['SignIn', 'Register', 'ForgotPassword', 'Generic', 'UserPermissionValidation', 'BindNewIdentifier']);
  const key = (phone, type) => `${type}:${String(phone).replace(/^\+/, '')}`;
  return {
    deliver(data, authorization) {
      const expected = Buffer.from(`Bearer ${config.secret}`);
      const actual = Buffer.from(authorization || '');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('unauthorized');
      const phone = String(data?.to ?? '').replace(/^\+/, '');
      if (!isMainlandMockPhone(phone) || !validTypes.has(data?.type) || !/^\d{6}$/.test(data?.payload?.code ?? '')) throw new Error('invalid_delivery');
      for (const [id, value] of codes) if (value.expiresAt <= now()) codes.delete(id);
      if (codes.size > 500) throw new Error('capacity_reached');
      codes.delete(key(phone, data.type));
      codes.set(key(phone, data.type), { code: data.payload.code, expiresAt: now() + 300_000 });
    },
    resolveAccountCode(data) {
      const phone = String(data?.identifier?.value ?? '').replace(/^\+/, '');
      if (data?.identifier?.type !== 'phone' || !isMainlandMockPhone(phone) || data.code !== '123456') return data.code;
      // Simulated local handset for the native Account Center. The original
      // verification ID, session and server-side attempt/expiry checks remain intact.
      const purposes = ['UserPermissionValidation', 'BindNewIdentifier'];
      const latest = [...codes].reverse().find(([id, item]) => purposes.some((purpose) => id === key(phone, purpose)) && item.expiresAt > now());
      return latest?.[1].code ?? data.code;
    },
    resolve(data) {
      const phone = String(data?.phone ?? '').replace(/^\+/, '');
      if (!isMainlandMockPhone(phone) || data?.testCode !== '123456' || !validTypes.has(data?.type)) throw new Error('invalid_test_code');
      const item = codes.get(key(phone, data.type));
      if (!item || item.expiresAt <= now()) throw new Error('code_expired');
      return item.code;
    },
  };
}
// This marker selects a fixed local callback page; it grants no identity or
// account access. Native Account Center still validates its saved state/proofs.
export function accountWechatCallbackTarget(config, path, method) {
  if (!config.wechat || method !== 'GET' || !path.startsWith(`/callback/${config.wechat.connectorId}?`)) return null;
  const url = new URL(path, config.origin);
  if (url.origin !== config.origin || url.pathname !== `/callback/${config.wechat.connectorId}`
    || url.searchParams.getAll('delegate_flow').length !== 1 || url.searchParams.get('delegate_flow') !== 'account') return null;
  const target = new URL(config.wechat.accountCallback);
  for (const key of ['code', 'state', 'error', 'error_description']) {
    const value = url.searchParams.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
  return target.toString();
}
export function rewriteAccountWechatRequest(config, path, body) {
  if (!config.wechat || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (path === '/api/verifications/social' && body.connectorId === config.wechat.connectorId) {
    if (body.redirectUri !== config.wechat.accountCallback) throw new Error('Unexpected local account callback.');
    return { ...body, redirectUri: config.wechat.callbackUri };
  }
  if (path === '/api/verifications/social/verify' && body.connectorData?.redirectUri === config.wechat.accountCallback) {
    return { ...body, connectorData: { ...body.connectorData, redirectUri: config.wechat.callbackUri } };
  }
  return body;
}
export function createMockSmsServer(config, upstreamAddress = { hostname: 'logto', port: 3001 }) {
  const store = createMockSmsStore(config);
  return createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    const accountCallback = accountWechatCallbackTarget(config, req.url || '/', req.method);
    if (accountCallback) {
      res.writeHead(302, { Location: accountCallback, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(); return;
    }
    if (req.url === '/health' && req.method === 'GET') return reply(200, { status: 'ok', mode: 'local_mock' });
    if (req.url === '/__delegate_mock_sms/resolve') {
      if (req.headers.origin !== config.origin) return reply(403, { message: 'Untrusted origin' });
      res.setHeader('Access-Control-Allow-Origin', config.origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.writeHead(204); res.end(); return; }
    }
    if (!['/deliver', '/__delegate_mock_sms/resolve'].includes(req.url || '')) {
      // Local issuer proxy: preserve native Logto cookies and CSP. Never relax CSP.
      let replacement;
      const accountSocialRequest = config.wechat && ['/api/verifications/social', '/api/verifications/social/verify'].includes(req.url);
      if (req.method === 'POST' && (req.url === '/api/verifications/verification-code/verify' || accountSocialRequest)) {
        if (req.headers.origin !== config.origin) return reply(403, { message: 'Untrusted origin' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 8192) return reply(413, { message: 'Request too large' }); }
        try {
          const data = JSON.parse(body);
          replacement = JSON.stringify(accountSocialRequest ? rewriteAccountWechatRequest(config, req.url, data) : { ...data, code: store.resolveAccountCode(data) });
        }
        catch { return reply(400, { message: 'Invalid request' }); }
      }
      const headers = { ...req.headers };
      if (replacement) { delete headers['transfer-encoding']; headers['content-length'] = String(Buffer.byteLength(replacement)); }
      const upstream = httpRequest({ ...upstreamAddress, path: req.url, method: req.method, headers }, (response) => {
        res.writeHead(response.statusCode || 502, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) reply(502, { message: 'Local Logto is unavailable' }); else res.destroy(); });
      upstream.setTimeout(30_000, () => upstream.destroy());
      req.on('aborted', () => upstream.destroy());
      if (replacement) upstream.end(replacement); else req.pipe(upstream); return;
    }
    if (req.method !== 'POST') return reply(405, { message: 'Method not allowed' });
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 8192) { reply(413, { message: 'Request too large' }); return; } }
      const data = JSON.parse(body);
      if (req.url === '/deliver') { store.deliver(data, req.headers.authorization); return reply(200, { accepted: true }); }
      return reply(200, { code: store.resolve(data) });
    } catch { return reply(400, { message: '测试验证码不正确、未发送或已过期' }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = mockSmsConfig(process.env);
  createMockSmsServer(config).listen(Number(process.env.AUTH_MOCK_SMS_PORT || 3801), process.env.AUTH_MOCK_BIND_HOST || '127.0.0.1', () => console.log('Local mock SMS delivery service ready; messages and codes are not logged.'));
}
