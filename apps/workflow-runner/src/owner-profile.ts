import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getOwnerIdentityProfile, updateOwnerAvatar, IdentityProfileError } from '@delegate/web-data/owner-identity-profile';

export async function handleOwnerProfile(request: IncomingMessage, response: ServerResponse) {
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
    response.end(JSON.stringify(body));
  };
  const token = process.env.OWNER_PROFILE_INTERNAL_TOKEN;
  if (!token || token.length < 32) return reply(503, { error: 'Account profile is unavailable.' });
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.authorization || '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(401, { error: 'Unauthorized.' });
  if (request.method !== 'POST') return reply(405, { error: 'Method not allowed.' });
  try {
    let raw = '';
    for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 8192) return reply(413, { error: 'Request too large.' }); }
    let body;
    try { body = JSON.parse(raw); } catch { return reply(400, { error: 'Invalid request.' }); }
    if (!body || !['get', 'avatar'].includes(body.action) || !body.principal
      || Object.keys(body).some((key) => !['action', 'principal', 'avatar'].includes(key))
      || Object.keys(body.principal).some((key) => !['ownerId', 'issuer', 'subject'].includes(key))
      || ['ownerId', 'issuer', 'subject'].some((key) => typeof body.principal[key] !== 'string' || !body.principal[key] || body.principal[key].length > 2048)) {
      return reply(400, { error: 'Invalid request.' });
    }
    // The worker independently verifies the exact Owner identity link. The
    // endpoint cannot list users, change credentials or write other fields.
    const result = body.action === 'get' ? await getOwnerIdentityProfile(body.principal) : await updateOwnerAvatar(body.principal, body.avatar);
    return reply(200, result);
  } catch (error) {
    return reply(error instanceof IdentityProfileError ? error.status : 503, { error: error instanceof IdentityProfileError ? error.message : 'Account profile is temporarily unavailable.' });
  }
}
