import {
  createServer,
  request as createUpstreamRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_LISTEN_PORT = 4302;
const DEFAULT_UPSTREAM = "http://127.0.0.1:3002";
const ALLOWED_CALLBACK_PATHS = new Set([
  "/api/payments/wechat/notify",
  "/api/payments/wechat/refund-notify",
]);

export type WeChatPayCallbackProxyConfig = {
  listenPort: number;
  upstream: URL;
};

export function isAllowedWeChatPayCallbackTarget(
  method: string | undefined,
  requestTarget: string | undefined,
): boolean {
  return method === "POST"
    && typeof requestTarget === "string"
    && ALLOWED_CALLBACK_PATHS.has(requestTarget);
}

export function loadWeChatPayCallbackProxyConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WeChatPayCallbackProxyConfig {
  const portText = env.WECHAT_PAY_CALLBACK_PROXY_PORT?.trim();
  const listenPort = portText ? Number(portText) : DEFAULT_LISTEN_PORT;
  if (!Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
    throw new Error("WECHAT_PAY_CALLBACK_PROXY_PORT must be a valid TCP port.");
  }

  const upstream = new URL(
    env.WECHAT_PAY_CALLBACK_PROXY_UPSTREAM?.trim() || DEFAULT_UPSTREAM,
  );
  if (
    upstream.protocol !== "http:"
    || !isLoopbackHostname(upstream.hostname)
    || upstream.username
    || upstream.password
    || upstream.pathname !== "/"
    || upstream.search
    || upstream.hash
  ) {
    throw new Error(
      "WECHAT_PAY_CALLBACK_PROXY_UPSTREAM must be an origin-only loopback HTTP URL.",
    );
  }

  return { listenPort, upstream };
}

export function startWeChatPayCallbackProxy(
  config = loadWeChatPayCallbackProxyConfig(),
) {
  const server = createServer((request, response) => {
    if (!isAllowedWeChatPayCallbackTarget(request.method, request.url)) {
      response.writeHead(404, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const upstreamRequest = createUpstreamRequest(
      {
        protocol: config.upstream.protocol,
        hostname: config.upstream.hostname,
        port: config.upstream.port,
        method: "POST",
        path: request.url,
        headers: forwardedHeaders(request.headers, config.upstream.host),
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      },
    );
    upstreamRequest.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(502, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
        });
      }
      response.end(JSON.stringify({ error: "upstream_unavailable" }));
    });
    request.on("aborted", () => upstreamRequest.destroy());
    request.pipe(upstreamRequest);
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.listen(config.listenPort, "127.0.0.1", () => {
    process.stdout.write(
      `WeChat Pay callback proxy listening on http://127.0.0.1:${config.listenPort}\n`,
    );
  });
  return server;
}

function forwardedHeaders(
  headers: IncomingHttpHeaders,
  upstreamHost: string,
): IncomingHttpHeaders {
  const forwarded = { ...headers };
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete forwarded[name];
  }
  forwarded.host = upstreamHost;
  return forwarded;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1"
    || hostname === "localhost"
    || hostname === "[::1]";
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry!).href;
}

if (isMainModule()) {
  const server = startWeChatPayCallbackProxy();
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
