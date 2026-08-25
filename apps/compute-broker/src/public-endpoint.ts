import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

import { ipv4MappedAddressToIpv4 } from "@delegate/compute-protocol";

import { SessionError } from "./session-error";

const blockedHostSuffixes = [".local", ".localhost", ".internal", ".home.arpa"];
const nonPublicIpv4Blocks = createBlockList("ipv4", [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]);
const dockerDesktopDnsProxyIpv4Block = createBlockList("ipv4", [
  ["198.18.0.0", 15],
]);
const globalIpv6UnicastSpace = createBlockList("ipv6", [
  ["2000::", 3],
]);
const globallyReachableSpecialIpv6Blocks = createBlockList("ipv6", [
  ["2001:1::1", 128],
  ["2001:1::2", 128],
  ["2001:1::3", 128],
  ["2001:3::", 32],
  ["2001:4:112::", 48],
  ["2001:30::", 28],
]);
const nonPublicIpv6BlocksInsideGlobalUnicast = createBlockList("ipv6", [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3ffe::", 16],
  ["3fff::", 20],
]);

const publicOnlyDispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(
        hostname,
        {
          all: true,
          family: typeof options.family === "number" ? options.family : 0,
          hints: options.hints,
          verbatim: true,
        },
        (error, addresses) => {
          if (error) {
            callback(error, "", 0);
            return;
          }
          if (
            !addresses.length
            || addresses.some(({ address }) =>
              isNonPublicAddress(address)
              && !isAllowedDockerDesktopMcpProxyResolution(hostname, address)
            )
          ) {
            const blocked = new Error("mcp_endpoint_resolves_to_non_public_address");
            Object.assign(blocked, { code: "ENOTFOUND" });
            callback(blocked, "", 0);
            return;
          }
          if (options.all) {
            (
              callback as unknown as (
                error: NodeJS.ErrnoException | null,
                addresses: LookupAddress[],
              ) => void
            )(null, addresses);
            return;
          }
          const selected = addresses[0]!;
          callback(null, selected.address, selected.family);
        },
      );
    },
  },
});

export async function assertSafePublicMcpUrl(
  rawUrl: string,
  expectedOrigin?: string,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SessionError(400, "mcp_binding_invalid_url");
  }
  const privateTestEndpointAllowed = isPrivateTestEndpointAllowed();
  if (
    !privateTestEndpointAllowed
    && (
    url.protocol !== "https:"
    || Boolean(url.username)
    || Boolean(url.password)
    || url.hostname.length > 253
    )
  ) {
    throw new SessionError(400, "mcp_binding_requires_public_https_url");
  }
  if (expectedOrigin && url.origin !== expectedOrigin) {
    throw new SessionError(403, "mcp_binding_cross_origin_request_blocked");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    !privateTestEndpointAllowed
    && (
    hostname === "localhost"
    || blockedHostSuffixes.some((suffix) => hostname.endsWith(suffix))
    || isNonPublicAddress(hostname)
    )
  ) {
    throw new SessionError(403, "mcp_binding_non_public_endpoint_blocked");
  }
  return url;
}

export function createPublicOnlyMcpFetch(
  expectedOrigin: string,
  timeoutMs: number,
  limits: {
    maxRequestBytes: number;
    maxResponseBytes: number;
  } = {
    maxRequestBytes: 256 * 1024,
    maxResponseBytes: 4 * 1024 * 1024,
  },
): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const rawUrl = input instanceof URL
      ? input.toString()
      : typeof input === "string"
        ? input
        : input.url;
    const url = await assertSafePublicMcpUrl(rawUrl, expectedOrigin);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const requestInit = withBoundedRequestBody(input, {
      ...init,
      redirect: "error",
      signal,
    }, limits.maxRequestBytes);
    let response: Response;
    if (isPrivateTestEndpointAllowed()) {
      response = await fetch(url, requestInit);
    } else {
      response = await undiciFetch(url, {
        ...requestInit,
        dispatcher: publicOnlyDispatcher,
      } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
    }
    return withBoundedResponseBody(response, limits.maxResponseBytes);
  }) as typeof fetch;
}

function withBoundedRequestBody(
  input: RequestInfo | URL,
  init: RequestInit,
  maxBytes: number,
): RequestInit {
  const inputRequest = typeof Request !== "undefined" && input instanceof Request
    ? input
    : null;
  const body = init.body ?? inputRequest?.body ?? null;
  if (body === null) return init;

  const knownSize = getBodySize(body);
  if (knownSize !== null) {
    if (knownSize > maxBytes) {
      throw new SessionError(413, "mcp_request_payload_too_large");
    }
    return {
      ...init,
      ...(init.body === undefined && inputRequest?.body ? { body: inputRequest.body } : {}),
    };
  }

  if (isReadableStream(body)) {
    return {
      ...init,
      body: createByteLimitStream(body, maxBytes, 413, "mcp_request_payload_too_large"),
      // Node fetch requires duplex for a streamed request body.
      duplex: "half",
    } as RequestInit;
  }

  throw new SessionError(413, "mcp_request_payload_unsupported");
}

function withBoundedResponseBody(response: Response, maxBytes: number): Response {
  const declaredLength = parseContentLength(response.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > maxBytes) {
    if (response.body) {
      void response.body.cancel().catch(() => undefined);
    }
    throw new SessionError(502, "mcp_response_payload_too_large");
  }
  if (!response.body) return response;

  const body = createByteLimitStream(
    response.body,
    maxBytes,
    502,
    "mcp_response_payload_too_large",
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function getBodySize(body: BodyInit): number | null {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof URLSearchParams) {
    return Buffer.byteLength(body.toString(), "utf8");
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return null;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== "undefined" && value instanceof ReadableStream;
}

function createByteLimitStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  statusCode: number,
  errorCode: string,
): ReadableStream<Uint8Array> {
  let receivedBytes = 0;
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maxBytes) {
        throw new SessionError(statusCode, errorCode);
      }
      controller.enqueue(chunk);
    },
  }));
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isPrivateTestEndpointAllowed() {
  return process.env.NODE_ENV === "test"
    && process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS === "true";
}

export function isNonPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, "");
  const family = isIP(normalized);
  if (!family) return false;
  const mappedIpv4 = ipv4MappedAddressToIpv4(normalized);
  if (mappedIpv4) return isNonPublicAddress(mappedIpv4);
  const nat64Ipv4 = wellKnownNat64AddressToIpv4(normalized);
  if (nat64Ipv4) return isNonPublicAddress(nat64Ipv4);
  if (family === 6) {
    if (globallyReachableSpecialIpv6Blocks.check(normalized, "ipv6")) {
      return false;
    }
    return !globalIpv6UnicastSpace.check(normalized, "ipv6")
      || nonPublicIpv6BlocksInsideGlobalUnicast.check(normalized, "ipv6");
  }
  return nonPublicIpv4Blocks.check(normalized, "ipv4");
}

export function isAllowedDockerDesktopMcpProxyResolution(
  hostname: string,
  address: string,
): boolean {
  return process.env.DELEGATE_ALLOW_DOCKER_DESKTOP_MCP_DNS_PROXY === "true"
    && isIP(hostname) === 0
    && isIP(address) === 4
    && dockerDesktopDnsProxyIpv4Block.check(address, "ipv4");
}

function wellKnownNat64AddressToIpv4(address: string): string | null {
  const words = parseIpv6Words(address);
  if (
    !words
    || words.length !== 8
    || words[0] !== 0x64
    || words[1] !== 0xff9b
    || words.slice(2, 6).some((word) => word !== 0)
  ) {
    return null;
  }

  const high = words[6]!;
  const low = words[7]!;
  return [
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff,
  ].join(".");
}

function parseIpv6Words(address: string): number[] | null {
  const compressedParts = address.split("::");
  if (compressedParts.length > 2) return null;
  const left = parseIpv6WordSequence(compressedParts[0] ?? "");
  const right = parseIpv6WordSequence(compressedParts[1] ?? "");
  if (!left || !right) return null;

  if (compressedParts.length === 1) {
    return left.length === 8 ? left : null;
  }
  const missingWordCount = 8 - left.length - right.length;
  if (missingWordCount < 1) return null;
  return [
    ...left,
    ...Array<number>(missingWordCount).fill(0),
    ...right,
  ];
}

function parseIpv6WordSequence(value: string): number[] | null {
  if (!value) return [];
  const tokens = value.split(":");
  const words: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!token) return null;
    if (token.includes(".")) {
      if (index !== tokens.length - 1) return null;
      const octets = token.split(".");
      if (
        octets.length !== 4
        || octets.some((octet) => !/^\d{1,3}$/u.test(octet))
      ) {
        return null;
      }
      const values = octets.map(Number);
      if (values.some((octet) => octet > 255)) return null;
      words.push(
        (values[0]! << 8) | values[1]!,
        (values[2]! << 8) | values[3]!,
      );
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/u.test(token)) return null;
    words.push(Number.parseInt(token, 16));
  }
  return words;
}

function createBlockList(
  family: "ipv4" | "ipv6",
  blocks: ReadonlyArray<readonly [address: string, prefix: number]>,
): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of blocks) {
    blockList.addSubnet(address, prefix, family);
  }
  return blockList;
}
