import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

import {
  buildOpenCodeCaptureCommand,
  buildOpenCodeComputerUseCommand,
  parsePlaywrightBrowseArtifactPayload,
} from "../src/browser";
import { createSandboxProviderFromConfig, type SandboxProviderLease } from "../src/sandbox-provider";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: resolve(repoRoot, ".env.local"), override: false, quiet: true });
loadEnv({ path: resolve(repoRoot, ".env"), override: false, quiet: true });

const DEFAULT_BROWSER_IMAGE = "mcr.microsoft.com/playwright:v1.58.2-noble";
const DEFAULT_PLAYWRIGHT_VERSION = "1.58.2";
const SMOKE_PAGE_URL =
  "data:text/html;charset=utf-8,%3Ctitle%3EDelegate%20Daytona%20OpenCode%20Smoke%3C%2Ftitle%3E%3Cmain%3E%3Ch1%3EDelegate%20OpenCode%20Smoke%3C%2Fh1%3E%3Cp%3EThe%20Daytona%20VM%20browser%20capture%20is%20working.%3C%2Fp%3E%3C%2Fmain%3E";
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

async function main() {
  const apiKey = normalize(process.env.DAYTONA_API_KEY);
  if (!apiKey) {
    throw new Error("DAYTONA_API_KEY is required. Create it in Daytona Dashboard and store it in .env.local.");
  }

  const { provider, providerKind } = await createSandboxProviderFromConfig({
    sandboxProvider: "daytona",
    daytona: {
      apiKey,
      ...(normalize(process.env.DAYTONA_API_URL) ? { apiUrl: normalize(process.env.DAYTONA_API_URL) } : {}),
      ...(normalize(process.env.DAYTONA_TARGET) ? { target: normalize(process.env.DAYTONA_TARGET) } : {}),
    },
    sandboxLifecycle: {
      idleStopMinutes: numberFromEnv("SANDBOX_IDLE_STOP_MINUTES", 15),
      autoArchiveMinutes: numberFromEnv("SANDBOX_AUTO_ARCHIVE_MINUTES", 7 * 24 * 60),
      autoDeleteMinutes: numberFromEnv("SANDBOX_AUTO_DELETE_MINUTES", -1),
    },
  });

  if (providerKind !== "daytona") {
    throw new Error("Daytona provider was not selected even though DAYTONA_API_KEY is configured.");
  }

  const startedAt = Date.now();
  const sessionId = `daytona-opencode-smoke-${startedAt}`;
  let lease: SandboxProviderLease | null = null;

  try {
    lease = await provider.start({
      runnerType: "vm",
      image: normalize(process.env.COMPUTE_BROWSER_IMAGE) ?? DEFAULT_BROWSER_IMAGE,
      hostWorkspaceRoot: normalize(process.env.COMPUTE_HOST_WORKSPACE_ROOT) ?? process.cwd(),
      networkMode: "full",
      filesystemMode: "ephemeral_full",
      sessionId,
      sandboxIdentityId: sessionId,
      sandboxLeaseId: `lease-${sessionId}`,
      labels: {
        "delegate.smoke": "daytona-opencode",
      },
    });

    const command = buildOpenCodeComputerUseCommand({
      opencodeCommand: normalize(process.env.COMPUTE_NATIVE_OPENCODE_COMMAND) ?? "opencode",
      model: normalize(process.env.COMPUTE_NATIVE_OPENCODE_MODEL) ?? "opencode/default",
      playwrightVersion: normalize(process.env.COMPUTE_BROWSER_PLAYWRIGHT_VERSION) ?? DEFAULT_PLAYWRIGHT_VERSION,
      task:
        "Inspect the local Delegate smoke page and leave the browser ready for Delegate to capture. Do not click or type.",
      maxSteps: 2,
      allowMutations: false,
      currentUrl: SMOKE_PAGE_URL,
      currentTitle: "Delegate Daytona OpenCode Smoke",
      textSnippet: "Smoke test page for Delegate Daytona OpenCode computer-use integration.",
      screenshotBase64: TINY_PNG_BASE64,
      screenshotMimeType: "image/png",
    });

    const runResult = await provider.execute({
      runnerType: "vm",
      lease,
      command,
      maxCommandSeconds: numberFromEnv("DAYTONA_OPENCODE_SMOKE_SECONDS", 240),
      filesystemMode: "ephemeral_full",
      workingDirectory: undefined,
      sessionId,
      executionId: `exec-${sessionId}`,
    });

    if (runResult.exitCode !== 0) {
      throw new Error(
        [
          `OpenCode smoke command failed with exit code ${runResult.exitCode}.`,
          tailForLogs(runResult.stderr || runResult.stdout),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    const captureResult = await provider.execute({
      runnerType: "vm",
      lease,
      command: buildOpenCodeCaptureCommand(),
      maxCommandSeconds: numberFromEnv("DAYTONA_OPENCODE_SMOKE_SECONDS", 240),
      filesystemMode: "ephemeral_full",
      workingDirectory: undefined,
      sessionId,
      executionId: `capture-${sessionId}`,
    });

    if (captureResult.exitCode !== 0) {
      throw new Error(
        [
          `OpenCode capture command failed with exit code ${captureResult.exitCode}.`,
          tailForLogs(captureResult.stderr || captureResult.stdout),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    const payload = parsePlaywrightBrowseArtifactPayload(captureResult.stdout);
    if (!payload) {
      throw new Error(
        [
          "Could not parse browser capture from Daytona output.",
          `stdout length: ${captureResult.stdout.length}`,
          `stderr length: ${captureResult.stderr.length}`,
          tailForLogs(captureResult.stderr || captureResult.stdout),
        ].join("\n"),
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          providerKind,
          sandboxId: lease.providerSandboxId,
          transportKind: payload.transportKind,
          finalUrl: payload.finalUrl,
          title: payload.title,
          textSnippet: payload.textSnippet.slice(0, 240),
          executedActions: payload.executedActions ?? [],
          wallMs: Math.max(1, Date.now() - startedAt),
        },
        null,
        2,
      ),
    );
  } finally {
    if (lease && process.env.DAYTONA_OPENCODE_SMOKE_KEEP !== "true") {
      await provider.delete({ lease, sessionId }).catch((error) => {
        console.warn(`Failed to delete Daytona smoke sandbox: ${error instanceof Error ? error.message : error}`);
      });
    }
  }
}

function normalize(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function numberFromEnv(key: string, fallback: number) {
  const raw = normalize(process.env[key]);
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function tailForLogs(value: string) {
  const trimmed = value.trim();
  return trimmed.slice(Math.max(0, trimmed.length - 2000));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
