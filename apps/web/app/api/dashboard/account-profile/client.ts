import { IdentityProfileError, type IdentityProfilePrincipal, type OwnerIdentityProfile } from '@delegate/web-data/owner-identity-profile';

export async function requestOwnerProfile(principal: IdentityProfilePrincipal, action: 'get' | 'avatar', avatar?: unknown): Promise<OwnerIdentityProfile> {
  const token = process.env.OWNER_PROFILE_INTERNAL_TOKEN;
  const endpoint = process.env.OWNER_PROFILE_INTERNAL_ENDPOINT;
  if (!endpoint || !token || token.length < 32) throw new IdentityProfileError(503, 'Account profile is unavailable.');
  const response = await fetch(new URL('/internal/owner-profile', endpoint), {
    method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ principal, action, ...(action === 'avatar' ? { avatar } : {}) }),
  });
  if (!response.ok) throw new IdentityProfileError([400, 401, 403, 502, 503].includes(response.status) ? response.status : 503, 'Account profile request failed.');
  const data = await response.json();
  if (!data || typeof data.hasPassword !== 'boolean' || typeof data.wechatLinked !== 'boolean') throw new IdentityProfileError(502, 'Invalid account profile response.');
  return data as OwnerIdentityProfile;
}
