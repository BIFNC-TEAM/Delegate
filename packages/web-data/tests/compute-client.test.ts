import { afterEach, describe, expect, it, vi } from "vitest";

import {
  callComputeBroker,
  ComputeBrokerError,
} from "../src/compute-client";

const previousInternalToken = process.env.COMPUTE_BROKER_INTERNAL_TOKEN;
const previousBrokerUrl = process.env.COMPUTE_BROKER_URL;

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv("COMPUTE_BROKER_INTERNAL_TOKEN", previousInternalToken);
  restoreEnv("COMPUTE_BROKER_URL", previousBrokerUrl);
});

describe("compute client public error boundary", () => {
  it("maps an allowlisted broker code to fixed public semantics", async () => {
    configureBroker();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "approval_request_already_resolved",
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })));

    const error = await callComputeBroker("/internal/test", {
      method: "POST",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ComputeBrokerError);
    expect(error).toMatchObject({
      code: "approval_request_already_resolved",
      statusCode: 409,
      publicMessage: "Approval is no longer pending.",
    });
  });

  it.each([
    "postgresql://owner:secret@db.internal/workspace",
    "SELECT api_key FROM private_config",
    "COMPUTE_BROKER_INTERNAL_TOKEN=top-secret",
    "https://user:password@mcp.example/?token=secret",
  ])("never exposes an unknown upstream error: %s", async (privateMessage) => {
    configureBroker();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: privateMessage,
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })));

    const error = await callComputeBroker("/internal/test", {
      method: "POST",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ComputeBrokerError);
    expect(error).toMatchObject({
      code: "compute_broker_upstream_error",
      statusCode: 502,
      publicMessage: "The compute service is temporarily unavailable.",
    });
    expect(String(error)).not.toContain(privateMessage);
  });
});

function configureBroker() {
  process.env.COMPUTE_BROKER_INTERNAL_TOKEN = "test-internal-token";
  process.env.COMPUTE_BROKER_URL = "http://compute-broker.test";
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
