import { describe, expect, it } from "vitest";
import { upsertMcpBindingRequestSchema } from "@delegate/compute-protocol";

import {
  assertSafePublicMcpUrl,
  createPublicOnlyMcpFetch,
  isAllowedDockerDesktopMcpProxyResolution,
  isNonPublicAddress,
} from "../src/public-endpoint";

describe("public MCP endpoint boundary", () => {
  it("rejects private, loopback, link-local, and mapped addresses", () => {
    expect(isNonPublicAddress("127.0.0.1")).toBe(true);
    expect(isNonPublicAddress("10.0.0.1")).toBe(true);
    expect(isNonPublicAddress("169.254.169.254")).toBe(true);
    expect(isNonPublicAddress("198.18.0.52")).toBe(true);
    expect(isNonPublicAddress("::1")).toBe(true);
    expect(isNonPublicAddress("fc00::1")).toBe(true);
    expect(isNonPublicAddress("::ffff:192.168.1.10")).toBe(true);
    expect(isNonPublicAddress("::ffff:7f00:1")).toBe(true);
    expect(isNonPublicAddress("::ffff:a00:1")).toBe(true);
    expect(isNonPublicAddress("::ffff:c0a8:1")).toBe(true);
    expect(isNonPublicAddress("0:0:0:0:0:ffff:7f00:1")).toBe(true);
    expect(isNonPublicAddress("1.1.1.1")).toBe(false);
    expect(isNonPublicAddress("::ffff:808:808")).toBe(false);
    expect(isNonPublicAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("allows Docker Desktop's synthetic public-DNS proxy only behind the local opt-in", () => {
    const previous = process.env.DELEGATE_ALLOW_DOCKER_DESKTOP_MCP_DNS_PROXY;
    try {
      delete process.env.DELEGATE_ALLOW_DOCKER_DESKTOP_MCP_DNS_PROXY;
      expect(
        isAllowedDockerDesktopMcpProxyResolution(
          "mcp.deepwiki.com",
          "198.18.0.52",
        ),
      ).toBe(false);

      process.env.DELEGATE_ALLOW_DOCKER_DESKTOP_MCP_DNS_PROXY = "true";
      expect(
        isAllowedDockerDesktopMcpProxyResolution(
          "mcp.deepwiki.com",
          "198.18.0.52",
        ),
      ).toBe(true);
      expect(
        isAllowedDockerDesktopMcpProxyResolution(
          "198.18.0.52",
          "198.18.0.52",
        ),
      ).toBe(false);
      expect(
        isAllowedDockerDesktopMcpProxyResolution(
          "internal.example",
          "10.0.0.2",
        ),
      ).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.DELEGATE_ALLOW_DOCKER_DESKTOP_MCP_DNS_PROXY;
      } else {
        process.env.DELEGATE_ALLOW_DOCKER_DESKTOP_MCP_DNS_PROXY = previous;
      }
    }
  });

  it("rejects non-globally-routable IANA and documentation ranges without blocking public unicast", () => {
    for (const address of [
      "192.0.0.1",
      "192.0.0.9",
      "192.0.2.1",
      "192.88.99.1",
      "198.51.100.1",
      "203.0.113.1",
      "240.0.0.1",
      "255.255.255.255",
      "::192.0.2.1",
      "64:ff9b::a00:1",
      "64:ff9b::c000:201",
      "64:ff9b:1::1",
      "100::1",
      "100:0:0:1::1",
      "2001::1",
      "2001:2::1",
      "2001:10::1",
      "2001:20::1",
      "2001:db8::1",
      "2002:c000:0201::1",
      "3ffe::1",
      "3fff::1",
      "5f00::1",
      "fec0::1",
    ]) {
      expect(isNonPublicAddress(address), address).toBe(true);
    }

    for (const address of [
      "8.8.8.8",
      "93.184.216.34",
      "2001:4860:4860::8888",
      "2606:4700:4700::1111",
      "64:ff9b::808:808",
      "2001:1::1",
      "2001:3::1",
      "2001:4:112::1",
      "2001:30::1",
    ]) {
      expect(isNonPublicAddress(address), address).toBe(false);
    }
  });

  it("requires public HTTPS and prevents transport cross-origin requests", async () => {
    const previous = process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS;
    delete process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS;
    try {
      await expect(assertSafePublicMcpUrl("http://example.com/mcp")).rejects.toThrow(
        "mcp_binding_requires_public_https_url",
      );
      await expect(assertSafePublicMcpUrl("https://127.0.0.1/mcp")).rejects.toThrow(
        "mcp_binding_non_public_endpoint_blocked",
      );
      await expect(assertSafePublicMcpUrl("https://192.0.2.1/mcp")).rejects.toThrow(
        "mcp_binding_non_public_endpoint_blocked",
      );
      await expect(assertSafePublicMcpUrl("https://[2001:db8::1]/mcp")).rejects.toThrow(
        "mcp_binding_non_public_endpoint_blocked",
      );
      await expect(
        assertSafePublicMcpUrl("https://redirect.example/mcp", "https://mcp.example"),
      ).rejects.toThrow("mcp_binding_cross_origin_request_blocked");
      await expect(
        assertSafePublicMcpUrl("https://mcp.example/next", "https://mcp.example"),
      ).resolves.toMatchObject({ pathname: "/next" });
    } finally {
      if (previous === undefined) delete process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS;
      else process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS = previous;
    }
  });

  it("rejects an unsafe endpoint before persisting an MCP binding", () => {
    const base = {
      slug: "crm",
      displayName: "CRM",
      transportKind: "streamable_http" as const,
      allowedToolNames: ["read_contact"],
      enabled: true,
      approvalRequired: true,
      estimatedTokensPerCall: 0,
      maxRetries: 2,
      retryBackoffMs: 1000,
    };
    expect(upsertMcpBindingRequestSchema.safeParse({
      ...base,
      serverUrl: "http://169.254.169.254/latest/meta-data",
    }).success).toBe(false);
    expect(upsertMcpBindingRequestSchema.safeParse({
      ...base,
      serverUrl: "https://[::ffff:7f00:1]/mcp",
    }).success).toBe(false);
    expect(upsertMcpBindingRequestSchema.safeParse({
      ...base,
      serverUrl: "https://[::ffff:a00:1]/mcp",
    }).success).toBe(false);
    expect(upsertMcpBindingRequestSchema.safeParse({
      ...base,
      serverUrl: "https://[::ffff:c0a8:1]/mcp",
    }).success).toBe(false);
    expect(upsertMcpBindingRequestSchema.safeParse({
      ...base,
      serverUrl: "https://mcp.example.com",
    }).success).toBe(true);
  });

  it("rejects oversized MCP requests before dispatch", async () => {
    const previousOverride = process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS;
    const originalFetch = global.fetch;
    let dispatched = false;
    process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS = "true";
    global.fetch = (async () => {
      dispatched = true;
      return new Response("{}");
    }) as typeof fetch;
    try {
      const guardedFetch = createPublicOnlyMcpFetch("https://mcp.example", 500, {
        maxRequestBytes: 8,
        maxResponseBytes: 64,
      });
      await expect(guardedFetch("https://mcp.example/messages", {
        method: "POST",
        body: "payload-too-large",
      })).rejects.toThrow("mcp_request_payload_too_large");
      expect(dispatched).toBe(false);
    } finally {
      global.fetch = originalFetch;
      if (previousOverride === undefined) {
        delete process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS;
      } else {
        process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS = previousOverride;
      }
    }
  });

  it("rejects declared and chunked oversized MCP responses", async () => {
    const previousOverride = process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS;
    const originalFetch = global.fetch;
    process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS = "true";
    try {
      const guardedFetch = createPublicOnlyMcpFetch("https://mcp.example", 500, {
        maxRequestBytes: 64,
        maxResponseBytes: 3,
      });

      global.fetch = (async () => new Response("oversized", {
        headers: { "content-length": "9" },
      })) as typeof fetch;
      await expect(
        guardedFetch("https://mcp.example/mcp"),
      ).rejects.toThrow("mcp_response_payload_too_large");

      global.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      }))) as typeof fetch;
      const response = await guardedFetch("https://mcp.example/mcp");
      await expect(response.arrayBuffer()).rejects.toThrow(
        "mcp_response_payload_too_large",
      );
    } finally {
      global.fetch = originalFetch;
      if (previousOverride === undefined) {
        delete process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS;
      } else {
        process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS = previousOverride;
      }
    }
  });
});
