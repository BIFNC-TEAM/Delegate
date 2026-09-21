import { createServer, request as httpRequest } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function mockSmsConfig(env) {
  const origin = new URL(env.LOGTO_ENDPOINT || '');
  if (env.NODE_ENV !== 'development' || env.DELEGATE_AUTH_MOCK_SMS !== 'true'
    || !['localhost', '127.0.0.1'].includes(origin.hostname) || origin.protocol !== 'http:') {
    throw new Error('Mock SMS requires explicit development mode and a loopback Logto issuer.');
  }
  const secret = env.AUTH_MOCK_SMS_TOKEN || '';
  if (secret.length < 32) throw new Error('Mock delivery token must have at least 32 characters.');
  const phones = new Set((env.AUTH_MOCK_SMS_ALLOWED_PHONES || '').split(',').map((x) => x.trim().replace(/^\+/, '')).filter(Boolean));
  if (!phones.size || [...phones].some((x) => !/^861[3-9]\d{9}$/.test(x))) throw new Error('Mock SMS requires an explicit mainland test-phone allowlist.');
  return { origin: origin.origin, secret, phones };
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
      if (!config.phones.has(phone) || !validTypes.has(data?.type) || !/^\d{6}$/.test(data?.payload?.code ?? '')) throw new Error('invalid_delivery');
      for (const [id, value] of codes) if (value.expiresAt <= now()) codes.delete(id);
      if (codes.size > 500) throw new Error('capacity_reached');
      codes.delete(key(phone, data.type));
      codes.set(key(phone, data.type), { code: data.payload.code, expiresAt: now() + 300_000 });
    },
    resolveAccountCode(data) {
      const phone = String(data?.identifier?.value ?? '').replace(/^\+/, '');
      if (data?.identifier?.type !== 'phone' || !config.phones.has(phone) || data.code !== '123456') return data.code;
      // Simulated local handset for the native Account Center. The original
      // verification ID, session and server-side attempt/expiry checks remain intact.
      const purposes = ['UserPermissionValidation', 'BindNewIdentifier'];
      const latest = [...codes].reverse().find(([id, item]) => purposes.some((purpose) => id === key(phone, purpose)) && item.expiresAt > now());
      return latest?.[1].code ?? data.code;
    },
    resolve(data) {
      const phone = String(data?.phone ?? '').replace(/^\+/, '');
      if (!config.phones.has(phone) || data?.testCode !== '123456' || !validTypes.has(data?.type)) throw new Error('invalid_test_code');
      const item = codes.get(key(phone, data.type));
      if (!item || item.expiresAt <= now()) throw new Error('code_expired');
      return item.code;
    },
  };
}
export function createMockSmsServer(config) {
  const store = createMockSmsStore(config);
  return createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
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
      if (req.url === '/api/verifications/verification-code/verify' && req.method === 'POST') {
        if (req.headers.origin !== config.origin) return reply(403, { message: 'Untrusted origin' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 8192) return reply(413, { message: 'Request too large' }); }
        try { const data = JSON.parse(body); replacement = JSON.stringify({ ...data, code: store.resolveAccountCode(data) }); }
        catch { return reply(400, { message: 'Invalid request' }); }
      }
      const headers = { ...req.headers };
      if (replacement) { delete headers['transfer-encoding']; headers['content-length'] = String(Buffer.byteLength(replacement)); }
      const upstream = httpRequest({ hostname: 'logto', port: 3001, path: req.url, method: req.method, headers }, (response) => {
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
