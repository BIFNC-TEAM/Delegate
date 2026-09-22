import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ link: vi.fn(), get: vi.fn(), update: vi.fn(), config: vi.fn(), store: vi.fn(), remove: vi.fn(), managedKey: vi.fn(), emailAvailable: vi.fn() }));
vi.mock('../src/prisma', () => ({ prisma: { ownerIdentityLink: { findFirst: mocks.link } } }));
vi.mock('../src/logto-management', () => ({ readLogtoManagementConfig: mocks.config, createLogtoManagementClient: () => ({ getUserProfile: mocks.get, updateUserAvatar: mocks.update, getAccountBindingCapabilities: async () => ({emailEnabled: await mocks.emailAvailable(),socialConnectors: []}) }) }));
vi.mock('../src/owner-settings', () => ({ readLogtoAccountCenterUrl: () => 'https://login.example.com/account' }));
vi.mock('../src/owner-avatar-storage', () => ({ MAX_AVATAR_FILE_BYTES: 5 * 1024 * 1024, storeOwnerAvatar: mocks.store, deleteOwnerAvatarObject: mocks.remove, managedAvatarObjectKey: mocks.managedKey, AvatarUploadError: class extends Error { constructor(readonly status: number, message: string) { super(message); } } }));
import { getOwnerIdentityProfile, updateOwnerAvatar, uploadOwnerAvatar, serializeIdentityProfile } from '../src/owner-identity-profile';
const principal = { ownerId: 'owner', issuer: 'https://login.example.com/oidc', subject: 'subject' };
beforeEach(() => { vi.clearAllMocks(); mocks.emailAvailable.mockResolvedValue(false); vi.stubEnv('LOGTO_ENDPOINT', 'https://login.example.com'); mocks.link.mockResolvedValue({ id: 'link' }); mocks.config.mockReturnValue({}); mocks.get.mockResolvedValue({ id: 'subject', hasPassword: false }); mocks.managedKey.mockReturnValue(null); mocks.remove.mockResolvedValue(undefined); mocks.update.mockResolvedValue({}); mocks.store.mockResolvedValue({ key:'avatars/fixture/new.jpg', url:'https://dashboard.example.com/api/avatars/fixture/new' }); });
afterEach(() => vi.unstubAllEnvs());
describe('Owner identity profile', () => {
  it('exposes bound-method status without returning identity tokens, password hashes, or provider IDs', () => {
    const result = serializeIdentityProfile({ primaryPhone: '8613800138000', hasPassword: true, identities: { wechat: { userId: 'private', accessToken: 'secret' } }, password: 'hash', avatar: 'javascript:alert(1)' }, 'https://login.example.com/account');
    expect(result).toMatchObject({ avatar: null, wechatLinked: true, hasPassword: true }); expect(JSON.stringify(result)).not.toMatch(/secret|private|hash/);
  });
  it('offers verified email binding only when the provider and account settings enable it', async () => {
    mocks.emailAvailable.mockResolvedValue(true);
    await expect(getOwnerIdentityProfile(principal)).resolves.toMatchObject({email:null,links:{email:'https://login.example.com/account/email'}});
    mocks.emailAvailable.mockResolvedValue(false);
    await expect(getOwnerIdentityProfile(principal)).resolves.toMatchObject({links:{email:null}});
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

describe('avatar upload and profile commit', () => {
  const input = {base64:Buffer.from('synthetic-image').toString('base64')};
  const url = 'https://dashboard.example.com/api/avatars/fixture/new';
  it('does not upload when the Owner identity is unlinked or suspended', async () => {
    mocks.link.mockResolvedValue(null); await expect(uploadOwnerAvatar(principal,input)).rejects.toMatchObject({status:403});expect(mocks.store).not.toHaveBeenCalled();
    mocks.link.mockResolvedValue({id:'link'});mocks.get.mockResolvedValue({isSuspended:true});await expect(uploadOwnerAvatar(principal,input)).rejects.toMatchObject({status:403});expect(mocks.store).not.toHaveBeenCalled();
  });
  it('stores the image then updates only this subject and confirms persistence',async()=>{
    mocks.get.mockResolvedValueOnce({hasPassword:false}).mockResolvedValueOnce({avatar:url,hasPassword:false});
    await expect(uploadOwnerAvatar(principal,input)).resolves.toMatchObject({avatar:url});
    expect(mocks.store).toHaveBeenCalledWith('owner',Buffer.from('synthetic-image'));expect(mocks.update).toHaveBeenCalledWith('subject',url);
  });
  it('preserves the current profile when COS upload fails',async()=>{
    mocks.store.mockRejectedValue(new Error('COS unavailable'));await expect(uploadOwnerAvatar(principal,input)).rejects.toThrow('COS unavailable');expect(mocks.update).not.toHaveBeenCalled();
  });
  it('cleans up only the newly uploaded object after a confirmed profile failure',async()=>{
    mocks.update.mockRejectedValue(new Error('unavailable'));mocks.get.mockResolvedValue({avatar:'https://example.com/old.jpg'});
    await expect(uploadOwnerAvatar(principal,input)).rejects.toMatchObject({status:502});expect(mocks.remove).toHaveBeenCalledWith('avatars/fixture/new.jpg');
  });
  it('recovers a committed update after a lost response instead of deleting the saved avatar',async()=>{
    mocks.update.mockRejectedValue(new Error('lost response'));mocks.get.mockResolvedValueOnce({avatar:'https://example.com/old.jpg'}).mockResolvedValueOnce({avatar:url,hasPassword:false});
    await expect(uploadOwnerAvatar(principal,input)).resolves.toMatchObject({avatar:url});expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('retains the new object if a saved update cannot be checked after a network failure',async()=>{
    const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      mocks.get.mockResolvedValueOnce({avatar:'https://example.com/old.jpg'}).mockRejectedValue(new Error('read unavailable'));
      await expect(uploadOwnerAvatar(principal,input)).rejects.toMatchObject({status:502});
      expect(mocks.remove).not.toHaveBeenCalled();expect(warning).toHaveBeenCalledWith('owner_avatar_confirmation_unavailable',{objectKey:'avatars/fixture/new.jpg'});
    } finally {warning.mockRestore();}
  });
  it('reports incomplete old-object cleanup after a successful profile save',async()=>{
    const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      mocks.get.mockResolvedValueOnce({avatar:'https://example.com/old.jpg'}).mockResolvedValueOnce({avatar:url,hasPassword:false});
      mocks.managedKey.mockReturnValue('avatars/fixture/old.jpg');mocks.remove.mockRejectedValue(new Error('cleanup unavailable'));
      await expect(uploadOwnerAvatar(principal,input)).resolves.toMatchObject({avatar:url,avatarCleanupPending:true});
      expect(warning).toHaveBeenCalledWith('owner_avatar_cleanup_failed',{objectKey:'avatars/fixture/old.jpg'});
    } finally {warning.mockRestore();}
  });
  it('rejects malformed encoding before any storage operation',async()=>{
    await expect(uploadOwnerAvatar(principal,{base64:'!not-base64'})).rejects.toMatchObject({status:400});expect(mocks.store).not.toHaveBeenCalled();
  });
});


describe('provider-specific binding actions',()=>{
  const connectors=[{id:'wechat-web',target:'wechat',name:{en:'WeChat','zh-CN':'微信'},editable:true},{id:'github-web',target:'github',name:{en:'GitHub'},editable:true}];
  it('returns independent provider status and exact native verified-flow routes',()=>{
    const profile=serializeIdentityProfile({identities:{wechat:{userId:'private-id',accessToken:'private-token'}}},'https://login.example.com/account',false,connectors);
    expect(profile.socialAccounts.map(a=>[a.provider,a.linked])).toEqual([['wechat',true],['github',false]]);
    expect(profile.socialAccounts[0]?.actions).toEqual({bind:'https://login.example.com/account/social/wechat-web',change:'https://login.example.com/account/social/wechat-web/change',remove:'https://login.example.com/account/social/wechat-web/remove'});
    expect(profile.links?.social).toBe('/dashboard?view=settings&settingsSection=connections');
    expect(JSON.stringify(profile)).not.toMatch(/private-id|private-token/);
  });
  it('does not offer mutations for read-only providers or an unavailable account center',()=>{
    expect(serializeIdentityProfile({},'https://login.example.com/account',false,connectors.map(c=>({...c,editable:false}))).socialAccounts.every(a=>a.actions===null)).toBe(true);
    expect(serializeIdentityProfile({},null,false,connectors).socialAccounts.every(a=>a.actions===null)).toBe(true);
  });
});
