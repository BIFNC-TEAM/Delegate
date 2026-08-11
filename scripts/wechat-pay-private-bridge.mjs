import { createServer, connect } from "node:net";

const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 4303;
const DEFAULT_TARGET_HOST = "127.0.0.1";
const DEFAULT_TARGET_PORT = 4302;

export function loadWeChatPayPrivateBridgeConfig(env = process.env) {
  const listenHost = env.WECHAT_PAY_CALLBACK_BRIDGE_HOST?.trim()
    || DEFAULT_LISTEN_HOST;
  const listenPort = parsePort(
    env.WECHAT_PAY_CALLBACK_BRIDGE_PORT,
    DEFAULT_LISTEN_PORT,
    "WECHAT_PAY_CALLBACK_BRIDGE_PORT",
  );
  const targetHost = env.WECHAT_PAY_CALLBACK_BRIDGE_TARGET_HOST?.trim()
    || DEFAULT_TARGET_HOST;
  const targetPort = parsePort(
    env.WECHAT_PAY_CALLBACK_BRIDGE_TARGET_PORT,
    DEFAULT_TARGET_PORT,
    "WECHAT_PAY_CALLBACK_BRIDGE_TARGET_PORT",
  );

  if (!isLoopbackOrPrivateIpv4(listenHost)) {
    throw new Error(
      "WECHAT_PAY_CALLBACK_BRIDGE_HOST must be loopback or a private IPv4 address.",
    );
  }
  if (!isLoopbackHostname(targetHost)) {
    throw new Error(
      "WECHAT_PAY_CALLBACK_BRIDGE_TARGET_HOST must be a loopback hostname.",
    );
  }

  return { listenHost, listenPort, targetHost, targetPort };
}

export function startWeChatPayPrivateBridge(
  config = loadWeChatPayPrivateBridgeConfig(),
) {
  const server = createServer((client) => {
    const upstream = connect({
      host: config.targetHost,
      port: config.targetPort,
    });

    client.setTimeout(15_000, () => client.destroy());
    upstream.setTimeout(15_000, () => upstream.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });

  server.listen(config.listenPort, config.listenHost, () => {
    process.stdout.write(
      `WeChat Pay private bridge listening on ${config.listenHost}:${config.listenPort}\n`,
    );
  });
  return server;
}

function parsePort(value, fallback, name) {
  const text = value?.trim();
  const port = text ? Number(text) : fallback;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  return port;
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1"
    || hostname === "localhost"
    || hostname === "::1";
}

function isLoopbackOrPrivateIpv4(hostname) {
  if (hostname === "127.0.0.1") return true;
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4
    || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const server = startWeChatPayPrivateBridge();
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
