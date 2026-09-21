import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ link: vi.fn(), get: vi.fn(), update: vi.fn(), config: vi.fn() }));
vi.mock('../src/prisma', () => ({ prisma: { ownerIdentityLink: { findFirst: mocks.link } } }));
vi.mock('../src/logto-management', () => ({ readLogtoManagementConfig: mocks.config, createLogtoManagementClient: () => ({ getUserProfile: mocks.get, updateUserAvatar: mocks.update }) }));
vi.mock('../src/owner-settings', () => ({ readLogtoAccountCenterUrl: () => 'https://login.example.com/account' }));
import { getOwnerIdentityProfile, updateOwnerAvatar, serializeIdentityProfile } from '../src/owner-identity-profile';
const principal = { ownerId: 'owner', issuer: 'https://login.example.com/oidc', subject: 'subject' };
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('LOGTO_ENDPOINT', 'https://login.example.com'); mocks.link.mockResolvedValue({ id: 'link' }); mocks.config.mockReturnValue({}); mocks.get.mockResolvedValue({ id: 'subject', hasPassword: false }); });
afterEach(() => vi.unstubAllEnvs());
describe('Owner identity profile', () => {
  it('exposes bound-method status without returning identity tokens, password hashes, or provider IDs', () => {
    const result = serializeIdentityProfile({ primaryPhone: '8613800138000', hasPassword: true, identities: { wechat: { userId: 'private', accessToken: 'secret' } }, password: 'hash', avatar: 'javascript:alert(1)' }, 'https://login.example.com/account');
    expect(result).toMatchObject({ avatar: null, wechatLinked: true, hasPassword: true }); expect(JSON.stringify(result)).not.toMatch(/secret|private|hash/);
  });
  it('requires exact Owner / issuer / subject linkage before accessing management API', async () => {
    mocks.link.mockResolvedValue(null); await expect(getOwnerIdentityProfile(principal)).rejects.toMatchObject({ status: 403 }); expect(mocks.get).not.toHaveBeenCalled();
    await expect(getOwnerIdentityProfile({ ...principal, issuer: 'https://evil.test/oidc' })).rejects.toMatchObject({ status: 403 });
  });
  it('reports configuration and suspended-account failures honestly', async () => {
    mocks.config.mockReturnValue(null); await expect(getOwnerIdentityProfile(principal)).rejects.toMatchObject({ status: 503 });
    mocks.config.mockReturnValue({}); mocks.get.mockResolvedValue({ isSuspended: true }); await expect(getOwnerIdentityProfile(principal)).rejects.toMatchObject({ status: 403 });
  });
  it.each(['http://example.com/a.png', 'https://user:password@example.com/a.png', null, 'x'.repeat(2049)])('rejects unsafe avatar %s', async (avatar) => {
    await expect(updateOwnerAvatar(principal, avatar)).rejects.toMatchObject({ status: 400 }); expect(mocks.update).not.toHaveBeenCalled();
  });
  it('writes only avatar and verifies it before reporting success', async () => {
    const avatar = 'https://example.com/a.png'; mocks.get.mockResolvedValueOnce({ hasPassword: false }).mockResolvedValueOnce({ avatar, hasPassword: false });
    await expect(updateOwnerAvatar(principal, avatar)).resolves.toMatchObject({ avatar }); expect(mocks.update).toHaveBeenCalledWith('subject', avatar);
    mocks.get.mockResolvedValue({ avatar }); await expect(updateOwnerAvatar(principal, '')).rejects.toMatchObject({ status: 502 });
  });
});
