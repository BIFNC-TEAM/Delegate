// Explicit integration test: creates and deletes ONLY a synthetic avatar object.
// Does not change any user's avatar, profile, or Logto identity.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { storeOwnerAvatar, readOwnerAvatarObject, deleteOwnerAvatarObject } from '../../packages/web-data/src/owner-avatar-storage.ts';
import { getKnowledgeObjectStoreConfig } from '../../packages/web-data/src/knowledge-storage.ts';
assert.equal(process.env.DELEGATE_AVATAR_COS_E2E, '1', 'Set DELEGATE_AVATAR_COS_E2E=1 explicitly.');
const display = new URL(process.env.AVATAR_DISPLAY_TEST_ORIGIN || process.env.NEXT_PUBLIC_DASHBOARD_URL);
assert(['localhost', '127.0.0.1', 'host.docker.internal'].includes(display.hostname), 'Display verification is local-only.');
const sharp = createRequire(new URL('../../packages/web-data/package.json', import.meta.url))('sharp');
let stored;
try {
  const image = await sharp({create:{width:800,height:600,channels:3,background:'#16a394'}}).png().toBuffer();
  stored = await storeOwnerAvatar('avatar-integration-' + randomUUID(), image);
  const [,owner,file] = stored.key.split('/');
  const bytes = await readOwnerAvatarObject(owner, file.replace('.jpg',''));
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.width,512); assert.equal(metadata.height,512); assert.equal(metadata.format,'jpeg');
  const config = getKnowledgeObjectStoreConfig();
  const direct = new URL(config.endpoint); direct.hostname = config.bucket + '.' + direct.hostname; direct.pathname = '/' + stored.key;
  const anonymous = await fetch(direct,{redirect:'manual',signal:AbortSignal.timeout(15000)});
  assert([403,404].includes(anonymous.status), 'COS object must not allow anonymous direct access.');
  const response = await fetch(new URL(new URL(stored.url).pathname, display), {signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200); assert.equal(response.headers.get('content-type'),'image/jpeg');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  console.log('PASS Tencent COS upload and readback; private object; 512x512 JPEG; application display returns identical bytes.');
} finally {
  if (stored) { await deleteOwnerAvatarObject(stored.key); console.log('Removed only this test run’s synthetic COS object.'); }
}
