import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
const outputDirectory = process.env.AUTH_UI_OUTPUT_DIR || 'dist';
const mockOrigin = process.env.DELEGATE_AUTH_UI_MOCK_SMS_ORIGIN || '';
if (mockOrigin && (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1'].includes(new URL(mockOrigin).hostname))) throw new Error('Mock SMS UI builds are local development only.');
await mkdir(`${outputDirectory}/assets`, { recursive: true });
await build({ entryPoints: ['src/main.tsx'], outfile: `${outputDirectory}/assets/delegate-auth.js`, bundle: true, minify: true, sourcemap: false, target: ['es2022'], jsx: 'automatic', define: { __MOCK_SMS_ORIGIN__: JSON.stringify(mockOrigin), 'process.env.NODE_ENV': JSON.stringify('production') } });
await copyFile('index.html', `${outputDirectory}/index.html`);
console.log(`Built auth experience (${mockOrigin ? 'LOCAL MOCK SMS' : 'real verification'}).`);

await writeFile(`${outputDirectory}/build-mode.json`, JSON.stringify({mode:mockOrigin?'local-mock':'real'}));
