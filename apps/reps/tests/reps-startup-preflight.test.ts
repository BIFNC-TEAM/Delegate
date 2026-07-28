import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  preflightWeChatPayRuntime: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  preflightWeChatPayRuntime:
    mocks.preflightWeChatPayRuntime,
}));

import { register } from "../instrumentation";

describe("representative app startup preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("accepts a ready node runtime", () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    mocks.preflightWeChatPayRuntime.mockReturnValue({
      ready: true,
      status: "disabled",
      collectionEnabled: false,
      processingEnabled: false,
      errorCode: null,
    });

    expect(() => register()).not.toThrow();
  });

  it("fails startup using only the stable preflight code", () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.preflightWeChatPayRuntime.mockReturnValue({
      ready: false,
      status: "misconfigured",
      collectionEnabled: false,
      processingEnabled: true,
      errorCode: "wechat_pay_configuration_invalid",
    });

    expect(() => register()).toThrow(
      "wechat_pay_configuration_invalid",
    );
  });

  it("does not run server credential checks in non-node runtimes", () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");

    register();

    expect(
      mocks.preflightWeChatPayRuntime,
    ).not.toHaveBeenCalled();
  });
});
