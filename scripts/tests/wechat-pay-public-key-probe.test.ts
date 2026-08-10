import { describe, expect, it, vi } from "vitest";

import {
  WeChatPayConfigurationError,
  WeChatPayProtocolError,
  type WeChatPayPublicKeyProbeConfig,
} from "../../packages/web-data/src/index";
import {
  runWeChatPayPublicKeyProbeCli,
  type WeChatPayPublicKeyProbeCliDependencies,
  type WeChatPayPublicKeyProbeCliIo,
} from "../wechat-pay-public-key-probe";

const sensitiveValues = [
  "1900000109",
  "PUB_KEY_ID_01111111111111111111111111111111",
  "merchant-private-key-secret",
  "wechat-public-key-secret",
];

function createHarness() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const config: WeChatPayPublicKeyProbeConfig = {
    merchantId: sensitiveValues[0]!,
    merchantCertificateSerialNumber: "7A2A3B4C5D6E",
    merchantPrivateKey: sensitiveValues[2]!,
    publicKeyId: sensitiveValues[1]!,
    publicKey: sensitiveValues[3]!,
  };
  const dependencies: WeChatPayPublicKeyProbeCliDependencies = {
    loadConfig: vi.fn(() => config),
    probe: vi.fn().mockResolvedValue({
      status: "verified",
      requestVerificationMode: "public_key",
      responseVerificationMode: "public_key",
      verifiedAt: "2026-08-04T02:00:00.000Z",
    }),
  };
  const io: WeChatPayPublicKeyProbeCliIo = {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  };
  return { dependencies, io, stdout, stderr };
}

describe("WeChat Pay public-key probe CLI", () => {
  it("prints one redacted success result", async () => {
    const harness = createHarness();

    await expect(
      runWeChatPayPublicKeyProbeCli([], harness),
    ).resolves.toBe(0);

    expect(harness.stdout).toHaveLength(1);
    expect(JSON.parse(harness.stdout[0]!)).toEqual({
      status: "verified",
      requestVerificationMode: "public_key",
      responseVerificationMode: "public_key",
      verifiedAt: "2026-08-04T02:00:00.000Z",
    });
    expect(harness.stderr).toEqual([]);
    expect(harness.dependencies.loadConfig).toHaveBeenCalledOnce();
    expect(harness.dependencies.probe).toHaveBeenCalledOnce();
    assertNoSensitiveOutput(harness);
  });

  it("maps configuration and provider failures to stable redacted results", async () => {
    for (const [error, exitCode, reason] of [
      [
        new WeChatPayConfigurationError(
          "invalid merchant-private-key-secret",
        ),
        2,
        "configuration_invalid",
      ],
      [
        new WeChatPayProtocolError(
          "provider exposed PUB_KEY_ID_01111111111111111111111111111111",
        ),
        1,
        "probe_failed",
      ],
      [new Error("unexpected wechat-public-key-secret"), 3, "unexpected_error"],
    ] as const) {
      const harness = createHarness();
      vi.mocked(harness.dependencies.probe).mockRejectedValue(error);

      await expect(
        runWeChatPayPublicKeyProbeCli([], harness),
      ).resolves.toBe(exitCode);

      expect(harness.stdout).toEqual([]);
      expect(harness.stderr).toEqual([
        JSON.stringify({ status: "failed", reason }),
      ]);
      assertNoSensitiveOutput(harness);
    }
  });

  it("rejects arguments without loading credentials or making a request", async () => {
    const harness = createHarness();

    await expect(
      runWeChatPayPublicKeyProbeCli(["--verbose"], harness),
    ).resolves.toBe(2);

    expect(harness.dependencies.loadConfig).not.toHaveBeenCalled();
    expect(harness.dependencies.probe).not.toHaveBeenCalled();
    expect(harness.stderr).toEqual([
      JSON.stringify({
        status: "failed",
        reason: "unexpected_arguments",
      }),
    ]);
    assertNoSensitiveOutput(harness);
  });
});

function assertNoSensitiveOutput(input: {
  stdout: readonly string[];
  stderr: readonly string[];
}) {
  const output = [...input.stdout, ...input.stderr].join("\n");
  for (const sensitiveValue of sensitiveValues) {
    expect(output).not.toContain(sensitiveValue);
  }
}
