import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
const outputDirectory = process.env.AUTH_UI_OUTPUT_DIR || 'dist';
const mockOrigin = process.env.DELEGATE_AUTH_UI_MOCK_SMS_ORIGIN || '';
const localWechatCallback = process.env.DELEGATE_AUTH_WECHAT_LOCAL_CALLBACK_URI || '';
if (mockOrigin && (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1'].includes(new URL(mockOrigin).hostname))) throw new Error('Mock SMS UI builds are local development only.');
let relayLabels;
if (localWechatCallback) {
  const callback = new URL(localWechatCallback);
  const match = /^\/_delegate\/local-wechat\/([A-Za-z0-9_-]+)$/.exec(callback.pathname);
  if (process.env.NODE_ENV !== 'development' || callback.protocol !== 'https:' || callback.port || callback.username || callback.password
    || callback.search || callback.hash || !match || ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)
    || callback.hostname !== process.env.WECHAT_WEB_CALLBACK_DOMAIN) {
    throw new Error('Local WeChat relay requires development mode and the explicitly approved public callback domain.');
  }
  const router = 'traefik.http.routers.delegate-local-wechat';
  const redirect = 'traefik.http.middlewares.delegate-local-wechat-redirect.redirectregex';
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Service labels only: no task-template/image/credentials update or Logto restart.
  // No caller-controlled destination: this exact path goes only to this local connector.
  relayLabels = {
    [`${router}.entrypoints`]: 'https',
    [`${router}.rule`]: `Host(\`${callback.hostname}\`) && Path(\`${callback.pathname}\`) && Method(\`GET\`)`,
    [`${router}.priority`]: '20000',
    [`${router}.service`]: 'delegate-logto-core',
    [`${router}.tls`]: 'true',
    [`${router}.tls.certresolver`]: 'lehttp',
    [`${router}.middlewares`]: 'delegate-local-wechat-headers,delegate-local-wechat-redirect',
    [`${redirect}.regex`]: `^${escapeRegex(callback.origin + callback.pathname)}(\\?.*)?$`,
    [`${redirect}.replacement`]: `http://127.0.0.1:3301/callback/${match[1]}\${1}`,
    [`${redirect}.permanent`]: 'false',
    'traefik.http.middlewares.delegate-local-wechat-headers.headers.customresponseheaders.Cache-Control': 'no-store',
    'traefik.http.middlewares.delegate-local-wechat-headers.headers.customresponseheaders.Referrer-Policy': 'no-referrer',
  };
}
await mkdir(`${outputDirectory}/assets`, { recursive: true });
await build({ entryPoints: ['src/main.tsx'], outfile: `${outputDirectory}/assets/delegate-auth.js`, bundle: true, minify: true, sourcemap: false, target: ['es2022'], jsx: 'automatic', define: { __MOCK_SMS_ORIGIN__: JSON.stringify(mockOrigin), __WECHAT_LOCAL_CALLBACK_URI__: JSON.stringify(localWechatCallback), 'process.env.NODE_ENV': JSON.stringify('production') } });
await copyFile('index.html', `${outputDirectory}/index.html`);
console.log(`Built auth experience (${mockOrigin ? 'LOCAL MOCK SMS' : 'real verification'}; local WeChat relay: ${relayLabels ? 'configured' : 'off'}).`);
await writeFile(`${outputDirectory}/build-mode.json`, JSON.stringify({ mode: mockOrigin ? 'local-mock' : 'real', localWechatCallback: localWechatCallback || null }));
if (relayLabels) await writeFile(`${outputDirectory}/local-wechat-relay-labels.json`, JSON.stringify(relayLabels, null, 2));
else await rm(`${outputDirectory}/local-wechat-relay-labels.json`, { force: true });
