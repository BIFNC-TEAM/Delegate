import { describe, expect, it } from "vitest";

describe("getNativeComputerProviderReadiness", () => {
  it("reports missing model and credentials without pretending readiness", async () => {
    process.env.COMPUTE_BROKER_INTERNAL_TOKEN ??= "test-internal-token";
    const { getNativeComputerProviderReadiness } = await import("../src/native-browser");
    const readiness = getNativeComputerProviderReadiness({
      COMPUTE_NATIVE_OPENAI_ENABLED: "true",
      COMPUTE_NATIVE_OPENAI_MODEL: "",
      COMPUTE_NATIVE_ANTHROPIC_ENABLED: "true",
      COMPUTE_NATIVE_ANTHROPIC_MODEL: "claude-computer",
      ANTHROPIC_API_KEY: "",
    });

    expect(readiness).toEqual([
      {
        provider: "openai",
        enabled: true,
        status: "missing_model",
        transportKind: "openai_computer",
        reason: "native_model_not_configured",
      },
      {
        provider: "anthropic",
        enabled: true,
        status: "missing_credentials",
        model: "claude-computer",
        transportKind: "claude_computer_use",
        reason: "provider_credentials_missing",
      },
      {
        provider: "opencode",
        enabled: false,
        status: "disabled",
        model: "opencode/default",
        transportKind: "opencode_computer_use",
        reason: "provider_disabled",
      },
    ]);
  });

  it("requires Daytona before reporting OpenCode as ready", async () => {
    process.env.COMPUTE_BROKER_INTERNAL_TOKEN ??= "test-internal-token";
    const { getNativeComputerProviderReadiness } = await import("../src/native-browser");

    const dockerReadiness = getNativeComputerProviderReadiness({
      COMPUTE_NATIVE_OPENCODE_ENABLED: "true",
      COMPUTE_NATIVE_OPENCODE_MODEL: "qwen/opencode",
      SANDBOX_PROVIDER: "docker",
      DAYTONA_API_KEY: "",
    }).find((provider) => provider.provider === "opencode");

    expect(dockerReadiness).toEqual({
      provider: "opencode",
      enabled: true,
      status: "missing_sandbox",
      model: "qwen/opencode",
      transportKind: "opencode_computer_use",
      reason: "daytona_sandbox_required",
    });

    const daytonaReadiness = getNativeComputerProviderReadiness({
      COMPUTE_NATIVE_OPENCODE_ENABLED: "true",
      COMPUTE_NATIVE_OPENCODE_MODEL: "qwen/opencode",
      SANDBOX_PROVIDER: "daytona",
      DAYTONA_API_KEY: "daytona_test_key",
    }).find((provider) => provider.provider === "opencode");

    expect(daytonaReadiness).toEqual({
      provider: "opencode",
      enabled: true,
      status: "ready",
      model: "qwen/opencode",
      transportKind: "opencode_computer_use",
      reason: null,
    });
  });
});

describe("buildOpenCodeComputerUseCommand", () => {
  it("builds a Daytona sandbox command that runs OpenCode and captures the retained browser state", async () => {
    const { buildOpenCodeCaptureCommand, buildOpenCodeComputerUseCommand } = await import("../src/browser");
    const command = buildOpenCodeComputerUseCommand({
      opencodeCommand: "opencode",
      model: "qwen/opencode",
      playwrightVersion: "1.58.2",
      task: "Inspect the visible pricing plan.",
      maxSteps: 2,
      allowMutations: false,
      currentUrl: "https://example.com/pricing",
      currentTitle: "Pricing",
      textSnippet: "Starter plan",
      screenshotBase64: "ZmFrZQ==",
      screenshotMimeType: "image/png",
    });

    expect(command).toContain("opencode");
    expect(command).toContain("run --auto --model 'qwen/opencode'");
    expect(command).toContain("npm install --silent --no-save opencode-ai");
    expect(command).toContain("delegate-browser-tool.cjs");
    expect(command).toContain("Mutation approval: not allowed");
    expect(command).toContain("opencode_computer_use");
    expect(command).not.toContain("PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node delegate-browser-tool.cjs inspect");

    const captureCommand = buildOpenCodeCaptureCommand();
    expect(captureCommand).toContain("node delegate-browser-tool.cjs inspect");
  });
});

describe("deriveNativeComputerUsePreflight", () => {
  const providerReadiness = [
    {
      provider: "openai" as const,
      enabled: true,
      status: "ready" as const,
      model: "computer-use-openai",
      transportKind: "openai_computer" as const,
      reason: null,
    },
  ];

  it("reports no browser session when there is nothing to hand off", async () => {
    process.env.COMPUTE_BROKER_INTERNAL_TOKEN ??= "test-internal-token";
    const { deriveNativeComputerUsePreflight } = await import("../src/native-browser");
    const preflight = deriveNativeComputerUsePreflight({
      sessionId: "session_demo",
      browserSession: null,
      providerReadiness,
    });

    expect(preflight.state).toBe("no_browser_session");
    expect(preflight.sessionId).toBe("session_demo");
    expect(preflight.browserSessionId).toBeNull();
  });

  it("reports missing screenshot before native handoff is allowed", async () => {
    process.env.COMPUTE_BROKER_INTERNAL_TOKEN ??= "test-internal-token";
    const { deriveNativeComputerUsePreflight } = await import("../src/native-browser");
    const preflight = deriveNativeComputerUsePreflight({
      sessionId: "session_demo",
      browserSession: {
        id: "browser_demo",
        computeSessionId: "session_demo",
        transportKind: "playwright",
        currentUrl: "https://example.com",
        currentTitle: "Example",
        lastNavigationAt: new Date("2026-03-25T09:00:00.000Z"),
        latestNavigation: {
          id: "nav_demo",
          requestedUrl: "https://example.com",
          finalUrl: "https://example.com",
          textSnippet: "Example page",
          screenshotArtifactId: null,
          jsonArtifactId: "artifact_json",
        },
      },
      providerReadiness,
    });

    expect(preflight.state).toBe("missing_screenshot");
    expect(preflight.latestJsonArtifactId).toBe("artifact_json");
  });

  it("returns ready when a screenshot and provider lane both exist", async () => {
    process.env.COMPUTE_BROKER_INTERNAL_TOKEN ??= "test-internal-token";
    const { deriveNativeComputerUsePreflight } = await import("../src/native-browser");
    const preflight = deriveNativeComputerUsePreflight({
      browserSession: {
        id: "browser_demo",
        computeSessionId: "session_demo",
        transportKind: "playwright",
        currentUrl: "https://example.com",
        currentTitle: "Example",
        lastNavigationAt: new Date("2026-03-25T09:00:00.000Z"),
        latestNavigation: {
          id: "nav_demo",
          requestedUrl: "https://example.com",
          finalUrl: "https://example.com",
          textSnippet: "Example page",
          screenshotArtifactId: "artifact_screen",
          jsonArtifactId: "artifact_json",
        },
      },
      providerReadiness,
    });

    expect(preflight.state).toBe("ready");
    expect(preflight.preferredProvider).toBe("openai");
    expect(preflight.targetTransportKind).toBe("openai_computer");
    expect(preflight.latestScreenshotArtifactId).toBe("artifact_screen");
  });
});
