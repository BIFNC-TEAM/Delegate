import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { createElement, type ReactNode } from "react";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as memorySettingsApi from "../app/dashboard/dashboard-memory-settings-api";
import {
  MemorySettingsRequestError,
  updateMemorySettings,
  type MemorySettings,
} from "../app/dashboard/dashboard-memory-settings-api";

const {
  policyFromSettings,
  requestMemorySettingsReload,
  resolveOpenVikingSyncPresentation,
} = loadRepresentativeMemorySettingsModule();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("representative memory settings behavior", () => {
  it("saves with CAS and reuses one idempotency key for a transient retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "temporary failure" }, 503))
      .mockResolvedValueOnce(jsonResponse({ data: {
        replayed: false,
        requestId: "request-2",
        settings: memorySettings(),
      } }));
    vi.stubGlobal("fetch", fetchMock);

    await updateMemorySettings(
      "delegate",
      7,
      policyFromSettings(memorySettings()),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]?.[1];
    const second = fetchMock.mock.calls[1]?.[1];
    expect(first?.method).toBe("PATCH");
    expect(JSON.parse(String(first?.body))).toMatchObject({
      expectedRevision: 7,
    });
    expect(new Headers(second?.headers).get("Idempotency-Key"))
      .toBe(new Headers(first?.headers).get("Idempotency-Key"));
    expect(new Headers(second?.headers).get("X-Request-Id"))
      .not.toBe(new Headers(first?.headers).get("X-Request-Id"));
  });

  it("does not retry an optimistic concurrency conflict", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      error: "revision conflict",
      code: "memory_dashboard_version_conflict",
    }, 409));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateMemorySettings(
      "delegate",
      7,
      policyFromSettings(memorySettings()),
    )).rejects.toBeInstanceOf(MemorySettingsRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps short-term independent and permits supported cross-channel sharing", () => {
    const enabled = policyFromSettings(memorySettings({
      shortTermMemoryEnabled: true,
      contactMemoryCrossChannelSupported: true,
      contactMemoryCrossChannelEnabled: true,
    }));
    expect(enabled.basic.shortTermMemoryEnabled).toBe(true);
    expect(enabled.basic.contactMemoryCrossChannelEnabled).toBe(true);

    const contactDisabled = policyFromSettings(memorySettings({
      shortTermMemoryEnabled: true,
      contactMemoryCrossChannelSupported: true,
      contactMemoryEnabled: false,
      contactMemoryCrossChannelEnabled: true,
    }));
    expect(contactDisabled.basic.shortTermMemoryEnabled).toBe(true);
    expect(contactDisabled.basic.contactMemoryCrossChannelEnabled).toBe(false);
  });

  it("fails closed when an older server does not report cross-channel support", () => {
    const policy = policyFromSettings(memorySettings({
      contactMemoryCrossChannelEnabled: true,
    }));

    expect(policy.basic.contactMemoryCrossChannelEnabled).toBe(false);
  });

  it("allows Representative Experience to drive Web automatic extraction", () => {
    const policy = policyFromSettings(memorySettings({
      contactMemoryEnabled: false,
      representativeExperienceEnabled: true,
      autoExtract: true,
      webExtractEnabled: true,
    }));
    expect(policy.basic.representativeExperienceEnabled).toBe(true);
    expect(policy.basic.autoExtract).toBe(true);
    expect(policy.channels.web.extractEnabled).toBe(true);
  });

  it("preserves independent Matrix and Telegram recall and extraction settings", () => {
    const policy = policyFromSettings(memorySettings({
      autoExtract: true,
      matrixRecallEnabled: true,
      matrixExtractEnabled: true,
      telegramRecallEnabled: true,
      telegramExtractEnabled: true,
    }));

    expect(policy.channels.matrix).toEqual({
      recallEnabled: true,
      extractEnabled: true,
    });
    expect(policy.channels.telegram).toEqual({
      recallEnabled: true,
      extractEnabled: true,
    });
    expect(policy.basic.contactMemoryCrossChannelEnabled).toBe(false);
  });

  it("separates OpenViking operation from a known inventory capability limit", () => {
    const presentation = resolveOpenVikingSyncPresentation({
      providerStatus: "PARTIAL",
      inventoryCoverage: "KNOWN_PROJECTIONS_ONLY",
      queuedCount: 0,
      activeCount: 0,
      retryingCount: 0,
      failedCount: 0,
      deletePendingCount: 0,
      lastProjectedAt: null,
      lastReconciledAt: "2026-08-05T09:19:00.000Z",
      lastErrorCode: "openviking_inventory_no_snapshot_cursor",
      reconciliationIntervalMinutes: 5,
      retryStrategy: "capped_exponential_backoff_with_leases",
    });

    expect(presentation).toEqual({
      connectionStatus: "CONFIGURED",
      operationalStatus: "IDLE",
      inventoryCapability: "LIMITED",
      actionableErrorCode: null,
    });
  });

  it("prefers explicit OpenViking connection and operation truth", () => {
    const presentation = resolveOpenVikingSyncPresentation({
      connectionStatus: "CONFIGURED",
      operationalStatus: "HEALTHY",
      capabilityCode: null,
      providerStatus: "PARTIAL",
      inventoryCoverage: "FULL",
      queuedCount: 0,
      activeCount: 2,
      retryingCount: 0,
      failedCount: 0,
      deletePendingCount: 0,
      lastProjectedAt: "2026-08-05T09:19:00.000Z",
      lastReconciledAt: "2026-08-05T09:19:00.000Z",
      lastErrorCode: "projection_hash_mismatch",
      reconciliationIntervalMinutes: 5,
      retryStrategy: "capped_exponential_backoff_with_leases",
    });

    expect(presentation).toMatchObject({
      connectionStatus: "CONFIGURED",
      operationalStatus: "HEALTHY",
      inventoryCapability: "FULL",
      actionableErrorCode: "projection_hash_mismatch",
    });
  });

  it("reports whether an authoritative reload succeeded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      data: memorySettings(),
    })));
    await expect(requestMemorySettingsReload("delegate"))
      .resolves.toMatchObject({ success: true });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      error: "unavailable",
    }, 503)));
    await expect(requestMemorySettingsReload("delegate"))
      .resolves.toEqual({ success: false });
  });
});

function memorySettings(input: {
  shortTermMemoryEnabled?: boolean;
  contactMemoryEnabled?: boolean;
  contactMemoryCrossChannelSupported?: boolean;
  contactMemoryCrossChannelEnabled?: boolean;
  representativeExperienceEnabled?: boolean;
  autoExtract?: boolean;
  webExtractEnabled?: boolean;
  matrixRecallEnabled?: boolean;
  matrixExtractEnabled?: boolean;
  telegramRecallEnabled?: boolean;
  telegramExtractEnabled?: boolean;
} = {}): MemorySettings {
  return {
    representative: {
      id: "representative-1",
      slug: "delegate",
      displayName: "Delegate",
    },
    configured: true,
    revision: 7,
    basic: {
      longTermMemoryEnabled: true,
      shortTermMemoryEnabled: input.shortTermMemoryEnabled ?? true,
      contactMemoryEnabled: input.contactMemoryEnabled ?? true,
      contactMemoryCrossChannelEnabled:
        input.contactMemoryCrossChannelEnabled ?? false,
      ...(input.contactMemoryCrossChannelSupported === undefined
        ? {}
        : {
            contactMemoryCrossChannelSupported:
              input.contactMemoryCrossChannelSupported,
          }),
      representativeExperienceEnabled:
        input.representativeExperienceEnabled ?? false,
      autoExtract: input.autoExtract ?? false,
      automaticPolicyEnabled: true,
    },
    channels: {
      web: {
        recallSupported: true,
        extractSupported: true,
        recallEnabled: true,
        extractEnabled: input.webExtractEnabled ?? false,
      },
      matrix: {
        recallSupported: true,
        extractSupported: true,
        recallEnabled: input.matrixRecallEnabled ?? false,
        extractEnabled: input.matrixExtractEnabled ?? false,
      },
      telegram: {
        recallSupported: true,
        extractSupported: true,
        recallEnabled: input.telegramRecallEnabled ?? false,
        extractEnabled: input.telegramExtractEnabled ?? false,
      },
    },
    retention: { days: 30, expiryAction: "ARCHIVE" },
    advanced: {
      provider: "openviking",
      recallLimit: 6,
      recallThreshold: 0.01,
      namespaceManagedByServer: true,
      targetManagedByServer: true,
      managedAgentId: null,
      managedNamespace: "mem_rep_1",
      managedTargetUri: null,
      sync: null,
    },
    updatedAt: "2026-08-04T01:00:00.000Z",
    settingsHref: "/dashboard?view=representatives&rep=delegate&repSection=setup&setupSection=memory",
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function loadRepresentativeMemorySettingsModule(): typeof import("../app/dashboard/dashboard-representative-memory-settings") {
  const source = readFileSync(
    new URL("../app/dashboard/dashboard-representative-memory-settings.tsx", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "dashboard-representative-memory-settings.tsx",
  }).outputText;
  const nodeRequire = createRequire(import.meta.url);
  const localRequire = (specifier: string) => {
    if (specifier === "next/link") {
      return {
        __esModule: true,
        default: ({ children, href, ...props }: {
          children?: ReactNode;
          href: string;
        }) => createElement("a", { ...props, href }, children),
      };
    }
    if (specifier === "@delegate/web-ui") {
      return {
        DashboardSurface: ({ children }: { children?: ReactNode }) =>
          createElement("section", null, children),
      };
    }
    if (specifier === "./dashboard-memory-settings-api") {
      return memorySettingsApi;
    }
    return nodeRequire(specifier);
  };
  const evaluatedModule: { exports: Record<string, unknown> } = { exports: {} };
  const evaluate = new Function("require", "module", "exports", compiled) as (
    require: (specifier: string) => unknown,
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
  ) => void;
  evaluate(localRequire, evaluatedModule, evaluatedModule.exports);
  return evaluatedModule.exports as typeof import("../app/dashboard/dashboard-representative-memory-settings");
}
