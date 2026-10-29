import { ProxyAgent } from "undici";

let configuredProxy: string | undefined;
let proxyAgent: ProxyAgent | undefined;

// Optional server-side proxy, scoped to Notion only. Never change the global dispatcher.
export const notionFetch: typeof fetch = async (input, init) => {
  const proxy = process.env.NOTION_HTTPS_PROXY?.trim() || undefined;
  if (proxy !== configuredProxy) {
    const previous = proxyAgent;
    proxyAgent = proxy ? new ProxyAgent(proxy) : undefined;
    configuredProxy = proxy;
    void previous?.close().catch(() => undefined);
  }
  return fetch(input, { ...init, ...(proxyAgent ? { dispatcher: proxyAgent } : {}) });
};
