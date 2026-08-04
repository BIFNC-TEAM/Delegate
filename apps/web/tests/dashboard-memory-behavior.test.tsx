import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import ts from "typescript";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as dashboardMemoryApi from "../app/dashboard/dashboard-memory-api";
import {
  executeMemoryAction,
  type MemoryEntry,
  type MemoryOperationsResponse,
  updateMemorySettings,
} from "../app/dashboard/dashboard-memory-api";

const dashboardMemory = loadDashboardMemoryModule();
const {
  buildEntryActionPayload,
  buildMemoryHref,
  currentMemoryRequest,
  defaultCorrectionField,
  EntryDetail,
  entryActionCommands,
  loadOperationsSection,
  nextFocusTrapIndex,
  operationRetryAction,
} = dashboardMemory;
const representativeMemorySettings = loadRepresentativeMemorySettingsModule();
const {
  policyFromSettings,
  requestMemorySettingsReload,
} = representativeMemorySettings;

const entryUpdatedAt = "2026-08-04T01:00:00.000Z";
const cleanupUpdatedAt = "2026-08-04T02:00:00.000Z";

const baseMemory: MemoryEntry = {
  id: "memory-1",
  kind: "memory",
  memoryType: "contact",
  scope: "CONTACT_CHANNEL",
  category: "CONTACT_PREFERENCE",
  status: "ACTIVE",
  sourceChannel: "WEB",
  summary: "Prefers concise replies.",
  contact: { id: "contact-1", label: "Lin" },
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: entryUpdatedAt,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Memory System dashboard behavior", () => {
  it("guards stale request data before a detail can remain actionable", () => {
    const stale = {
      requestKey: "rep-a:entries:entryId=old:0",
      section: "entries" as const,
      entries: { detail: baseMemory },
    };

    expect(currentMemoryRequest(stale, "rep-b:entries:entryId=new:0")).toBeNull();
    expect(currentMemoryRequest(stale, stale.requestKey)).toBe(stale);
  });

  it("renders a representative correction with a legal selected enum", () => {
    const representativeMemory: MemoryEntry = {
      ...baseMemory,
      memoryType: "representative_experience",
      scope: "REPRESENTATIVE",
      category: "REPRESENTATIVE_RESPONSE_PATTERN",
    };

    expect(defaultCorrectionField(representativeMemory)).toBe("response_format_preference");
    const html = renderToStaticMarkup(
      createElement(EntryDetail, {
        closeHref: "/dashboard?view=memory&section=entries",
        entry: representativeMemory,
        locale: "zh",
        representativeName: "Delegate",
        representativeSlug: "delegate",
        reload: () => undefined,
        setNotice: () => undefined,
      }),
    );

    expect(html).toContain('value="response_format_preference" selected=""');
    expect(html).not.toContain('value="reply_language" selected=""');
  });

  it("renders only actions allowed by the lifecycle state machine", () => {
    const activeCommands = entryActionCommands(baseMemory);
    expect(activeCommands).toContain("suppress_memory");
    expect(activeCommands).not.toContain("request_deletion");

    const activeHtml = renderToStaticMarkup(
      createElement(EntryDetail, {
        closeHref: "/dashboard?view=memory&section=entries",
        entry: baseMemory,
        locale: "zh",
        representativeName: "Delegate",
        representativeSlug: "delegate",
        reload: () => undefined,
        setNotice: () => undefined,
      }),
    );
    expect(activeHtml).toContain("停用");
    expect(activeHtml).not.toContain("永久删除");

    const suppressed = { ...baseMemory, status: "SUPPRESSED" };
    expect(entryActionCommands(suppressed)).toContain("request_deletion");
  });

  it("uses the cleanup proof revision for cleanup retry", () => {
    const deleting: MemoryEntry = {
      ...baseMemory,
      status: "DELETE_PENDING",
      cleanup: {
        status: "FAILED",
        updatedAt: cleanupUpdatedAt,
      },
    };
    const payload = buildEntryActionPayload({
      command: "retry_cleanup",
      correctionField: "reply_language",
      correctionValue: "",
      entry: deleting,
      note: "retry after provider recovery",
    });

    expect(payload).toMatchObject({
      action: "retry_cleanup",
      memoryId: "memory-1",
      expectedUpdatedAt: cleanupUpdatedAt,
    });
    expect(payload?.expectedUpdatedAt).not.toBe(entryUpdatedAt);
  });

  it("preserves operations when reconciliation independently fails", async () => {
    const operations = operationsResponse();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/operations?")) return jsonResponse(operations);
      return jsonResponse({ error: "reconciliation unavailable" }, 503);
    }));

    const result = await loadOperationsSection(
      "delegate",
      {},
      "delegate:operations:0",
      new AbortController().signal,
    );

    expect(result.section).toBe("operations");
    if (result.section !== "operations") throw new Error("Unexpected section.");
    expect(result.operations).toEqual(operations);
    expect(result.operationsError).toBe(false);
    expect(result.reconciliation).toBeNull();
    expect(result.reconciliationError).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/operations?")) {
        return jsonResponse({ error: "operations unavailable" }, 503);
      }
      return jsonResponse({
        representative: operations.representative,
        page: operations.page,
        items: [],
      });
    }));
    const inverse = await loadOperationsSection(
      "delegate",
      {},
      "delegate:operations:1",
      new AbortController().signal,
    );
    if (inverse.section !== "operations") throw new Error("Unexpected section.");
    expect(inverse.operations).toBeNull();
    expect(inverse.operationsError).toBe(true);
    expect(inverse.reconciliation?.items).toEqual([]);
    expect(inverse.reconciliationError).toBe(false);
  });

  it("keeps reconciliation list and issue pagination independently deep-linked", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/operations?")) return jsonResponse(operationsResponse());
      return jsonResponse({
        representative: operationsResponse().representative,
        page: operationsResponse().page,
        items: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await loadOperationsSection(
      "delegate",
      {
        runId: "reconciliation-1",
        reconciliationCursor: "list-cursor",
        reconciliationAsOf: entryUpdatedAt,
        reconciliationLimit: "10",
        reconciliationItemCursor: "issue-cursor",
        reconciliationItemLimit: "5",
      },
      "delegate:operations:pagination",
      new AbortController().signal,
    );

    const reconciliationUrl = new URL(
      String(fetchMock.mock.calls.find(([input]) => String(input).includes("/reconciliation?"))?.[0]),
      "https://delegate.test",
    );
    expect(Object.fromEntries(reconciliationUrl.searchParams)).toMatchObject({
      rep: "delegate",
      runId: "reconciliation-1",
      cursor: "list-cursor",
      asOf: entryUpdatedAt,
      limit: "10",
      itemCursor: "issue-cursor",
      itemLimit: "5",
    });

    const current = new URLSearchParams({
      view: "memory",
      section: "operations",
      runId: "reconciliation-1",
      reconciliationCursor: "list-cursor",
      reconciliationItemCursor: "issue-cursor",
      reconciliationItemLimit: "5",
    });
    const issueNext = new URL(buildMemoryHref(
      "/dashboard",
      current,
      { reconciliationItemCursor: "issue-next" },
    ), "https://delegate.test");
    expect(issueNext.searchParams.get("reconciliationCursor")).toBe("list-cursor");
    expect(issueNext.searchParams.get("reconciliationItemCursor")).toBe("issue-next");

    const anotherRun = new URL(buildMemoryHref(
      "/dashboard",
      current,
      { runId: "reconciliation-2" },
    ), "https://delegate.test");
    expect(anotherRun.searchParams.get("reconciliationCursor")).toBe("list-cursor");
    expect(anotherRun.searchParams.has("reconciliationItemCursor")).toBe(false);
    expect(anotherRun.searchParams.get("reconciliationItemLimit")).toBe("5");

    const closed = new URL(buildMemoryHref(
      "/dashboard",
      current,
      { runId: null },
    ), "https://delegate.test");
    expect(closed.searchParams.has("runId")).toBe(false);
    expect(closed.searchParams.has("reconciliationItemCursor")).toBe(false);
    expect(closed.searchParams.has("reconciliationItemLimit")).toBe(false);
  });

  it("retries network and 5xx failures once with the same idempotency key", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(jsonResponse({ data: { accepted: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await executeMemoryAction("delegate", { action: "enqueue_reconciliation" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get("Idempotency-Key")).toBeTruthy();
    expect(secondHeaders.get("Idempotency-Key")).toBe(firstHeaders.get("Idempotency-Key"));
    expect(secondHeaders.get("X-Request-Id")).not.toBe(firstHeaders.get("X-Request-Id"));
  });

  it("does not retry a 4xx governance conflict", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: "revision conflict", code: "memory_dashboard_version_conflict" }, 409),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeMemoryAction("delegate", {
      action: "suppress_memory",
      memoryId: "memory-1",
      expectedUpdatedAt: entryUpdatedAt,
      reasonCode: "owner_dashboard_suppress_memory",
    })).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx once without changing its idempotency key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "provider unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ data: { accepted: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await executeMemoryAction("delegate", { action: "enqueue_reconciliation" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(secondHeaders.get("Idempotency-Key")).toBe(firstHeaders.get("Idempotency-Key"));
  });

  it("saves settings with CAS and reuses the idempotency key on retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "temporary failure" }, 503))
      .mockResolvedValueOnce(jsonResponse({ data: {
        replayed: false,
        requestId: "request-2",
        settings: {},
      } }));
    vi.stubGlobal("fetch", fetchMock);
    const policy = {
      basic: {
        longTermMemoryEnabled: true,
        contactMemoryEnabled: true,
        representativeExperienceEnabled: false,
        autoExtract: false,
      },
      channels: {
        web: { recallEnabled: true, extractEnabled: false },
        matrix: { recallEnabled: false, extractEnabled: false },
        telegram: { recallEnabled: false, extractEnabled: false },
      },
      retention: { days: 30, expiryAction: "ARCHIVE" as const },
      advanced: {
        provider: "openviking" as const,
        recallLimit: 6,
        recallThreshold: 0.01,
      },
    };

    await updateMemorySettings("delegate", 7, policy);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstInit = fetchMock.mock.calls[0]?.[1];
    const secondInit = fetchMock.mock.calls[1]?.[1];
    expect(firstInit?.method).toBe("PATCH");
    expect(JSON.parse(String(firstInit?.body))).toMatchObject({
      expectedRevision: 7,
      policy,
    });
    expect(new Headers(secondInit?.headers).get("Idempotency-Key"))
      .toBe(new Headers(firstInit?.headers).get("Idempotency-Key"));
  });

  it("fails closed when legacy settings enable Web extraction without Contact Memory", () => {
    const settings = memorySettings({
      contactMemoryEnabled: false,
      representativeExperienceEnabled: true,
      autoExtract: true,
      webExtractEnabled: true,
    });

    const policy = policyFromSettings(settings);

    expect(policy.basic.representativeExperienceEnabled).toBe(true);
    expect(policy.basic.autoExtract).toBe(false);
    expect(policy.channels.web.extractEnabled).toBe(false);
  });

  it("reports whether a settings reload actually succeeded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: memorySettings() })));
    await expect(requestMemorySettingsReload("delegate"))
      .resolves.toMatchObject({ success: true });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "unavailable" }, 503)));
    await expect(requestMemorySettingsReload("delegate"))
      .resolves.toEqual({ success: false });
  });

  it("wraps focus only at mobile modal boundaries", () => {
    expect(nextFocusTrapIndex(-1, 3, false)).toBe(0);
    expect(nextFocusTrapIndex(-1, 3, true)).toBe(2);
    expect(nextFocusTrapIndex(0, 3, true)).toBe(2);
    expect(nextFocusTrapIndex(2, 3, false)).toBe(0);
    expect(nextFocusTrapIndex(1, 3, false)).toBeNull();
    expect(nextFocusTrapIndex(0, 0, false)).toBe(-1);
  });

  it("builds real projection and extraction retry actions only for retryable states", () => {
    const projection = operationRetryAction({
      id: "projection-1",
      kind: "projection",
      status: "FAILED",
      environment: "recall",
      createdAt: entryUpdatedAt,
      updatedAt: cleanupUpdatedAt,
    });
    expect(projection).toMatchObject({
      action: "retry_projection",
      projectionItemId: "projection-1",
      expectedUpdatedAt: cleanupUpdatedAt,
    });

    const extraction = operationRetryAction({
      id: "extraction-1",
      kind: "extraction",
      status: "FAILED",
      sourceChannel: "WEB",
      createdAt: entryUpdatedAt,
      updatedAt: cleanupUpdatedAt,
    });
    expect(extraction).toMatchObject({
      action: "retry_extraction",
      extractionRunId: "extraction-1",
      expectedUpdatedAt: cleanupUpdatedAt,
    });
    expect(operationRetryAction({
      id: "projection-2",
      kind: "projection",
      status: "ACTIVE",
      environment: "recall",
      createdAt: entryUpdatedAt,
      updatedAt: cleanupUpdatedAt,
    })).toBeNull();
  });
});

function operationsResponse(): MemoryOperationsResponse {
  return {
    representative: {
      id: "representative-1",
      slug: "delegate",
      displayName: "Delegate",
    },
    page: {
      asOf: entryUpdatedAt,
      limit: 25,
      hasMore: false,
      nextCursor: null,
    },
    items: [],
  };
}

function memorySettings(input: {
  contactMemoryEnabled?: boolean;
  representativeExperienceEnabled?: boolean;
  autoExtract?: boolean;
  webExtractEnabled?: boolean;
} = {}) {
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
      contactMemoryEnabled: input.contactMemoryEnabled ?? true,
      representativeExperienceEnabled:
        input.representativeExperienceEnabled ?? false,
      autoExtract: input.autoExtract ?? false,
      createsCandidatesOnly: true as const,
      automaticApprovalEnabled: false as const,
    },
    channels: {
      web: {
        recallSupported: true,
        extractSupported: true,
        recallEnabled: true,
        extractEnabled: input.webExtractEnabled ?? false,
      },
      matrix: {
        recallSupported: false,
        extractSupported: false,
        recallEnabled: false,
        extractEnabled: false,
      },
      telegram: {
        recallSupported: false,
        extractSupported: false,
        recallEnabled: false,
        extractEnabled: false,
      },
    },
    retention: { days: 30, expiryAction: "ARCHIVE" as const },
    advanced: {
      provider: "openviking" as const,
      recallLimit: 6,
      recallThreshold: 0.01,
      namespaceManagedByServer: true as const,
      targetManagedByServer: true as const,
    },
    updatedAt: entryUpdatedAt,
    settingsHref: "/dashboard?view=representatives&section=memory",
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function loadDashboardMemoryModule(): typeof import("../app/dashboard/dashboard-memory") {
  const source = readFileSync(
    new URL("../app/dashboard/dashboard-memory.tsx", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "dashboard-memory.tsx",
  }).outputText;
  const nodeRequire = createRequire(import.meta.url);
  const link = ({ children, href, ...props }: {
    children?: ReactNode;
    href: string | { pathname?: string };
  }) => createElement("a", {
    ...props,
    href: typeof href === "string" ? href : href.pathname ?? "#",
  }, children);
  const localRequire = (specifier: string) => {
    if (specifier === "next/link") {
      return { __esModule: true, default: link };
    }
    if (specifier === "next/navigation") {
      return {
        usePathname: () => "/dashboard",
        useSearchParams: () => new URLSearchParams("view=memory&section=entries"),
      };
    }
    if (specifier === "./dashboard-memory-api") return dashboardMemoryApi;
    return nodeRequire(specifier);
  };
  const evaluatedModule: { exports: Record<string, unknown> } = { exports: {} };
  const evaluate = new Function("require", "module", "exports", compiled) as (
    require: (specifier: string) => unknown,
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
  ) => void;
  evaluate(localRequire, evaluatedModule, evaluatedModule.exports);
  return evaluatedModule.exports as typeof import("../app/dashboard/dashboard-memory");
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
      return { __esModule: true, default: ({ children, href, ...props }: { children?: ReactNode; href: string }) => createElement("a", { ...props, href }, children) };
    }
    if (specifier === "@delegate/web-ui") {
      return { DashboardSurface: ({ children }: { children?: ReactNode }) => createElement("section", null, children) };
    }
    if (specifier === "./dashboard-memory-api") return dashboardMemoryApi;
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
