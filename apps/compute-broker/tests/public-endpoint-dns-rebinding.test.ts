import { afterEach, describe, expect, it, vi } from "vitest";

const dnsLookupMock = vi.hoisted(() => vi.fn());

vi.mock("node:dns", () => ({
  lookup: dnsLookupMock,
}));

const previousPrivateEndpointOverride =
  process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS;

afterEach(() => {
  dnsLookupMock.mockReset();
  if (previousPrivateEndpointOverride === undefined) {
    delete process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS;
  } else {
    process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS =
      previousPrivateEndpointOverride;
  }
});

describe("public MCP DNS rebinding boundary", () => {
  it("rejects a public-looking hostname when connection-time DNS resolves to loopback", async () => {
    delete process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS;
    dnsLookupMock.mockImplementation(
      (
        _hostname: string,
        _options: unknown,
        callback: (
          error: NodeJS.ErrnoException | null,
          addresses: Array<{ address: string; family: number }>,
        ) => void,
      ) => {
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
      },
    );
    const {
      assertSafePublicMcpUrl,
      createPublicOnlyMcpFetch,
    } = await import("../src/public-endpoint");

    await expect(
      assertSafePublicMcpUrl("https://rebind.example/mcp"),
    ).resolves.toMatchObject({
      hostname: "rebind.example",
    });

    const guardedFetch = createPublicOnlyMcpFetch(
      "https://rebind.example",
      500,
    );
    const error = await guardedFetch("https://rebind.example/mcp").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(readCauseMessage(error)).toContain(
      "mcp_endpoint_resolves_to_non_public_address",
    );
    expect(dnsLookupMock).toHaveBeenCalledWith(
      "rebind.example",
      expect.objectContaining({ all: true, verbatim: true }),
      expect.any(Function),
    );
  });

  it("rejects mixed public and private DNS answers instead of selecting the public address", async () => {
    delete process.env.DELEGATE_ALLOW_PRIVATE_MCP_TEST_ENDPOINTS;
    dnsLookupMock.mockImplementation(
      (
        _hostname: string,
        _options: unknown,
        callback: (
          error: NodeJS.ErrnoException | null,
          addresses: Array<{ address: string; family: number }>,
        ) => void,
      ) => {
        callback(null, [
          { address: "8.8.8.8", family: 4 },
          { address: "10.0.0.7", family: 4 },
        ]);
      },
    );
    const { createPublicOnlyMcpFetch } = await import("../src/public-endpoint");
    const guardedFetch = createPublicOnlyMcpFetch(
      "https://mixed-answer.example",
      500,
    );
    const error = await guardedFetch("https://mixed-answer.example/mcp").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(readCauseMessage(error)).toContain(
      "mcp_endpoint_resolves_to_non_public_address",
    );
  });
});

function readCauseMessage(value: unknown): string {
  if (!value || typeof value !== "object" || !("cause" in value)) return "";
  const cause = value.cause;
  return cause instanceof Error ? cause.message : "";
}
