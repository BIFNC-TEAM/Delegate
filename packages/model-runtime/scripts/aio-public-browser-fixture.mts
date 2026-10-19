/** Optional D19 public-page integration: existing provider/browser command, disposable AIO, no application DB. */
import { randomUUID } from 'node:crypto';
import { TencentAgsxSandboxProvider } from '../../../apps/compute-broker/src/tencent-agsx-provider.ts';
import { buildPlaywrightBrowseCommand, parsePlaywrightBrowseArtifactPayload } from '../../../apps/compute-broker/src/browser.ts';
import { observeBrowserPage } from '../src/pi/index.ts';
import type { PiCapabilityResult } from '../src/pi/types.ts';

export async function browsePublicFixture(url: string, record: (result: unknown) => Promise<void>): Promise<PiCapabilityResult> {
  if (process.env.EVAL_REAL_BROWSER !== '1') throw new Error('aio_test_not_enabled');
  if (url !== 'https://example.com' && url !== 'https://example.com/') return { status: 'unavailable', text: 'This integration fixture only permits https://example.com/.' };
  const apiKey = process.env.TENCENT_AGS_API_KEY;
  const allInOneTool = process.env.TENCENT_AGS_ALL_IN_ONE_TOOL;
  const domain = process.env.TENCENT_AGS_DOMAIN?.replace(/^https?:\/\//u, '').replace(/\/$/u, '')
    ?? (process.env.TENCENT_AGS_REGION ? `${process.env.TENCENT_AGS_REGION}.tencentags.com` : undefined);
  if (!apiKey || !allInOneTool || !domain) throw new Error('aio_test_configuration_missing');
  const provider = new TencentAgsxSandboxProvider({ apiKey, domain, allInOneTool });
  const sessionId = `d19-browser-${randomUUID()}`;
  const startedAt = Date.now();
  const lease = await provider.start({ sandboxIdentityId: sessionId, sandboxLeaseId: sessionId, creationKey: sessionId,
    runtimeClass: 'browser', runnerType: 'docker', image: allInOneTool, hostWorkspaceRoot: '/workspace', networkMode: 'full', filesystemMode: 'ephemeral_full', sessionId });
  let observation: Record<string, unknown> = {};
  try {
    const response = await provider.execute({ lease, sessionId, executionId: `${sessionId}-page`, runnerType: 'docker',
      command: buildPlaywrightBrowseCommand({ url, playwrightVersion: '1.58.2', anonymous: true }),
      maxCommandSeconds: 30, maxStdoutBytes: 1024 * 1024, maxStderrBytes: 64 * 1024, filesystemMode: 'ephemeral_full', workingDirectory: '/workspace' });
    const page = parsePlaywrightBrowseArtifactPayload(response.stdout);
    if (response.exitCode !== 0 || !page) throw new Error('aio_test_page_read_failed');
    observation = { title: page.title, finalUrl: page.finalUrl, httpStatus: page.httpStatus, observedAt: page.observedAt,
      text: page.textSnippet, hasScreenshot: Boolean(page.screenshotBase64), anonymous: page.profilePath === '__delegate_anonymous_v1__', elapsedMs: Date.now() - startedAt };
    return { status: 'completed', text: `Title: ${page.title}\n${page.textSnippet}`, observation: observeBrowserPage(page),
      sources: [{ id: 'aio-example-page', title: page.title, channel: 'web', url: page.finalUrl,
        ...(page.observedAt ? { observedAt: page.observedAt } : {}) }] };
  } finally {
    let cleanupCompleted = false;
    try { await provider.delete({ lease, sessionId }); cleanupCompleted = true; }
    finally { await record({ ...observation, cleanupCompleted, environment: 'real Tencent PUBLIC AIO, example.com public page' }); }
  }
}
