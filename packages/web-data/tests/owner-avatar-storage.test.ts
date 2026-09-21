import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const sharp = createRequire(import.meta.url)('sharp');
const mocks = vi.hoisted(() => ({ send: vi.fn(), config: vi.fn() }));
vi.mock('@aws-sdk/client-s3', async (original) => ({ ...await original<typeof import('@aws-sdk/client-s3')>(), S3Client: class { send = mocks.send; } }));
vi.mock('../src/knowledge-storage', () => ({ getKnowledgeObjectStoreConfig: mocks.config }));
import { avatarObjectKey, managedAvatarObjectKey, normalizeOwnerAvatar, storeOwnerAvatar, readOwnerAvatarObject, MAX_AVATAR_FILE_BYTES } from '../src/owner-avatar-storage';
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('NEXT_PUBLIC_DASHBOARD_URL', 'https://dashboard.example.com');
  mocks.config.mockReturnValue({ endpoint:'https://cos.ap-guangzhou.myqcloud.com', bucket:'test-bucket', region:'ap-guangzhou', forcePathStyle:false, accessKeyId:'test-key', secretAccessKey:'test-secret' });
  mocks.send.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());
const png = () => sharp({create:{width:640,height:320,channels:4,background:{r:10,g:160,b:145,alpha:0.5}}}).png().toBuffer();
describe('COS avatar storage', () => {
  it('decodes, center-crops and re-encodes as a 512px JPEG without embedded metadata', async () => {
    const original=await sharp(await png()).withMetadata({orientation:6}).jpeg().toBuffer();
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const result=await normalizeOwnerAvatar(original); const meta=await sharp(result).metadata();
    expect(meta).toMatchObject({format:'jpeg',width:512,height:512,hasAlpha:false}); expect(meta.exif).toBeUndefined();
  });
  it.each([new Uint8Array(), new Uint8Array(MAX_AVATAR_FILE_BYTES+1)])('rejects empty or oversized input before storage',async(bytes)=>{await expect(normalizeOwnerAvatar(bytes)).rejects.toMatchObject({status:413});expect(mocks.send).not.toHaveBeenCalled();});
  it('rejects SVG, corrupt data and excessive pixel dimensions',async()=>{
    await expect(normalizeOwnerAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>'))).rejects.toMatchObject({status:415});
    await expect(normalizeOwnerAvatar(Buffer.from('not an image'))).rejects.toMatchObject({status:415});
    await expect(normalizeOwnerAvatar(Buffer.from([137,80,78,71,13,10,26,10]))).rejects.toMatchObject({status:400});
    const huge=await sharp({create:{width:5000,height:5000,channels:3,background:'#fff'}}).png().toBuffer();
    await expect(normalizeOwnerAvatar(huge)).rejects.toMatchObject({status:400});
  });
  it('writes a private COS object under the owner namespace and returns a stable display URL',async()=>{
    const stored=await storeOwnerAvatar('owner-one',await png());
    expect(stored.key).toMatch(/^avatars\/[a-f0-9]{32}\/[a-f0-9-]{36}\.jpg$/);
    expect(stored.url).toMatch(/^https:\/\/dashboard.example.com\/api\/avatars\//);
    expect(mocks.send.mock.calls[0]![0].input).toMatchObject({Bucket:'test-bucket',Key:stored.key,ContentType:'image/jpeg',ACL:'private'});
    expect(managedAvatarObjectKey(stored.url,'owner-one')).toBe(stored.key);
    expect(managedAvatarObjectKey(stored.url,'another-owner')).toBeNull();
    expect(managedAvatarObjectKey(stored.url.replace('dashboard.example.com','evil.test'),'owner-one')).toBeNull();
  });
  it('fails closed if storage is not configured for Tencent COS',async()=>{
    mocks.config.mockReturnValue({endpoint:'http://localhost:9000',bucket:'local',region:'x'});
    await expect(storeOwnerAvatar('owner',await png())).rejects.toMatchObject({status:503});expect(mocks.send).not.toHaveBeenCalled();
  });
  it('rejects traversal and restricts reads to bounded JPEG objects',async()=>{
    expect(()=>avatarObjectKey('../knowledge','anything')).toThrow();
    const owner='a'.repeat(32),id='12345678-1234-4234-8234-123456789abc';
    mocks.send.mockResolvedValue({Body:Readable.from([Buffer.from([255,216,255,217])]),ContentType:'image/jpeg',ContentLength:4});
    await expect(readOwnerAvatarObject(owner,id)).resolves.toEqual(Buffer.from([255,216,255,217]));
    mocks.send.mockResolvedValue({Body:Readable.from(['<script>']),ContentType:'text/html'});
    await expect(readOwnerAvatarObject(owner,id)).rejects.toMatchObject({status:502});
    mocks.send.mockRejectedValue({name:'NoSuchKey'});await expect(readOwnerAvatarObject(owner,id)).rejects.toMatchObject({status:404});
  });
});
