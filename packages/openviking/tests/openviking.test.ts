import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  buildGovernedContactChannelMemoryRootUri,
  buildGovernedContactChannelMemoryVersionUri,
  buildGovernedRepresentativeExperienceRootUri,
  buildGovernedRepresentativeExperienceVersionUri,
  OpenVikingClient,
  buildRepresentativeKnowledgeDocuments,
  buildRepresentativeKnowledgeRootUri,
  buildRepresentativeResourceRootUri,
  buildRepresentativeVersionResourceRootUri,
  isPublicSafeText,
  resolveOpenVikingEnv,
  sanitizePublicSafeText,
} from "../src/index";

describe("OpenViking URI strategy", () => {
  it("isolates governed contact roots across 2 representatives, 2 contacts, and 3 channels", () => {
    const roots = ["rep_namespace_a", "rep_namespace_b"].flatMap((namespaceKey) =>
      ["contact_a", "contact_b"].flatMap((contactId) =>
        (["web", "matrix", "telegram"] as const).map((channel) =>
          buildGovernedContactChannelMemoryRootUri({
            namespaceKey,
            contactId,
            channel,
          }),
        ),
      ),
    );

    expect(roots).toHaveLength(12);
    expect(new Set(roots).size).toBe(12);
    expect(roots.every((root) => root.endsWith("/"))).toBe(true);
  });

  it("builds immutable governed memory version URIs without cross-version overlap", () => {
    const base = {
      namespaceKey: "Rep_Namespace_A",
      contactId: "Contact_A",
      channel: "matrix" as const,
      memoryId: "Memory_A",
    };
    const versionA = buildGovernedContactChannelMemoryVersionUri({
      ...base,
      memoryVersionId: "Version_A",
    });
    const versionB = buildGovernedContactChannelMemoryVersionUri({
      ...base,
      memoryVersionId: "Version_B",
    });

    expect(versionA).toBe(
      "viking://user/memories/delegate/Rep_Namespace_A/contacts/Contact_A/channels/matrix/memories/Memory_A/versions/Version_A.md",
    );
    expect(versionA).not.toBe(versionB);
  });

  it("preserves case and rejects inputs that lossy normalization could collide", () => {
    const buildRoot = (namespaceKey: string) =>
      buildGovernedContactChannelMemoryRootUri({
        namespaceKey,
        contactId: "contact_a",
        channel: "web",
      });

    expect(buildRoot("Tenant_A")).not.toBe(buildRoot("tenant_a"));
    expect(buildRoot("tenant-A")).toContain("/tenant-A/");
    expect(() => buildRoot("tenant A")).toThrow("Invalid governed memory namespaceKey");
    expect(() => buildRoot("tenant/A")).toThrow("Invalid governed memory namespaceKey");
    expect(() => buildRoot("..")).toThrow("Invalid governed memory namespaceKey");
    expect(() => buildRoot("!!!")).toThrow("Invalid governed memory namespaceKey");
    expect(() => buildRoot("")).toThrow("Invalid governed memory namespaceKey");
    expect(() => buildRoot("a".repeat(129))).toThrow(
      "Invalid governed memory namespaceKey",
    );
  });

  it("fails closed instead of normalizing contact, memory, or version identifiers", () => {
    expect(() =>
      buildGovernedContactChannelMemoryRootUri({
        namespaceKey: "rep_namespace_a",
        contactId: "contact/a",
        channel: "web",
      }),
    ).toThrow("Invalid governed memory contactId");
    expect(() =>
      buildGovernedContactChannelMemoryVersionUri({
        namespaceKey: "rep_namespace_a",
        contactId: "contact_a",
        channel: "web",
        memoryId: "memory a",
        memoryVersionId: "version_a",
      }),
    ).toThrow("Invalid governed memory memoryId");
    expect(() =>
      buildGovernedRepresentativeExperienceVersionUri({
        namespaceKey: "rep_namespace_a",
        memoryId: "memory_a",
        memoryVersionId: "version/a",
      }),
    ).toThrow("Invalid governed memory memoryVersionId");
  });

  it("keeps representative experience outside every contact-channel namespace", () => {
    const namespaceKey = "rep_namespace_a";
    const contactRoot = buildGovernedContactChannelMemoryRootUri({
      namespaceKey,
      contactId: "contact_a",
      channel: "web",
    });
    const experienceRoot = buildGovernedRepresentativeExperienceRootUri(namespaceKey);
    const experienceVersion = buildGovernedRepresentativeExperienceVersionUri({
      namespaceKey,
      memoryId: "memory_a",
      memoryVersionId: "version_a",
    });

    expect(experienceRoot).toBe(
      "viking://agent/memories/delegate/rep_namespace_a/representative-experience/",
    );
    expect(experienceRoot.startsWith(contactRoot)).toBe(false);
    expect(contactRoot.startsWith(experienceRoot)).toBe(false);
    expect(experienceVersion).toBe(`${experienceRoot}memories/memory_a/versions/version_a.md`);
  });

  it("rejects channels outside the P0 web, matrix, and telegram allowlist", () => {
    expect(() =>
      buildGovernedContactChannelMemoryRootUri({
        namespaceKey: "rep_namespace_a",
        contactId: "contact_a",
        channel: "wechat" as "web",
      }),
    ).toThrow("Unsupported governed memory channel");
  });

  it("builds representative-scoped resource roots", () => {
    expect(buildRepresentativeResourceRootUri("Lin Founder Rep")).toBe(
      "viking://resources/delegate/reps/lin-founder-rep/",
    );
  });

  it("builds non-overlapping published-version and knowledge roots", () => {
    expect(buildRepresentativeVersionResourceRootUri("lin-founder-rep", "version_7")).toBe(
      "viking://resources/delegate/reps/lin-founder-rep/versions/version_7/",
    );
    expect(buildRepresentativeKnowledgeRootUri("lin-founder-rep")).toBe(
      "viking://resources/delegate/reps/lin-founder-rep/knowledge/",
    );
  });
});

describe("OpenViking safety filters", () => {
  it("rejects obvious secrets", () => {
    expect(isPublicSafeText("my api_key is sk-live-123")).toBe(false);
    expect(sanitizePublicSafeText("password: hunter2")).toBeNull();
  });

  it("keeps normal public-safe memory text", () => {
    expect(sanitizePublicSafeText("The contact prefers Asia/Shanghai for scheduling.")).toBe(
      "The contact prefers Asia/Shanghai for scheduling.",
    );
  });
});

describe("OpenViking document builders", () => {
  it("creates representative knowledge documents", () => {
    const docs = buildRepresentativeKnowledgeDocuments({
      slug: "lin-founder-rep",
      representativeVersionId: "version_7",
      ownerName: "Lin",
      name: "Lin Rep",
      tagline: "Web founder representative",
      tone: "Calm and structured",
      languages: ["English", "Chinese"],
      groupActivation: "reply_or_mention",
      publicMode: true,
      humanInLoop: true,
      freeReplyLimit: 4,
      freeScope: ["faq", "materials"],
      paywalledIntents: ["pricing", "scheduling"],
      handoffWindowHours: 24,
      skills: ["faq_reply", "human_handoff"],
      knowledgePack: {
        identitySummary: "Public identity summary.",
        faq: [{ title: "What do you do?", summary: "We help founders." }],
        materials: [{ title: "Deck", summary: "Public deck", url: "https://example.com/deck" }],
        policies: [{ title: "Boundary", summary: "No private access." }],
      },
      pricing: [
        {
          tier: "free",
          name: "Free",
          stars: 0,
          summary: "Short answer",
          includedReplies: 2,
          includesPriorityHandoff: false,
        },
      ],
      handoffPrompt: "Please share fit, budget, and timing.",
    });

    expect(docs).toHaveLength(5);
    expect(docs[0]?.uri).toContain("/versions/version_7/identity/");
    expect(docs[1]?.uri).toContain("/faq/");
  });

});

describe("OpenViking legacy write boundary", () => {
  it("does not expose session commits or legacy memory document builders", () => {
    const clientSource = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
    const resourceSource = readFileSync(new URL("../src/resources.ts", import.meta.url), "utf8");
    const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const uriSource = readFileSync(new URL("../src/uris.ts", import.meta.url), "utf8");

    expect(clientSource).not.toContain("/api/v1/sessions");
    expect(clientSource).not.toContain("commitSession");
    expect(clientSource).not.toContain("/api/v1/fs/mv");
    expect(resourceSource).not.toContain("buildCollectorMemoryDocument");
    expect(resourceSource).not.toContain("buildPaymentMemoryDocument");
    expect(resourceSource).not.toContain("buildHandoffResolutionPatternDocument");
    expect(indexSource).not.toContain('export * from "./session"');
    expect(uriSource).not.toContain("buildRepresentativeContactMemoryUri");
    expect(uriSource).not.toContain("buildRepresentativeAgentMemoryUri");
    expect(uriSource).not.toContain("buildSessionScopedSearchRoot");
    expect(uriSource).not.toContain("buildSyncStagingUri");
  });
});

describe("OpenViking env config", () => {
  it("uses safe defaults", () => {
    const config = resolveOpenVikingEnv({});
    expect(config.enabled).toBe(false);
    expect(config.autoCaptureDefault).toBe(false);
    expect(config.autoRecallDefault).toBe(true);
    expect(config.embeddingDimension).toBe(3072);
  });

  it("keeps automatic capture disabled even when the legacy env flag is true", () => {
    const config = resolveOpenVikingEnv({
      OPENVIKING_AUTO_CAPTURE_DEFAULT: "true",
    });

    expect(config.autoCaptureDefault).toBe(false);
  });

  it("falls back to the root API key when the client key is omitted", () => {
    const config = resolveOpenVikingEnv({
      OPENVIKING_ENABLED: "true",
      OPENVIKING_BASE_URL: "http://localhost:1933",
      OPENVIKING_ROOT_API_KEY: "root-only-key",
    });

    expect(config.apiKey).toBe("root-only-key");
    expect(config.rootApiKey).toBe("root-only-key");
  });

  it("prefers the container-internal URL over the host URL", () => {
    const config = resolveOpenVikingEnv({
      OPENVIKING_ENABLED: "true",
      OPENVIKING_BASE_URL: "http://localhost:1933",
      OPENVIKING_INTERNAL_BASE_URL: "http://openviking:1933",
    });

    expect(config.baseUrl).toBe("http://openviking:1933");
  });

  it("accepts a dedicated model credential without enabling the main OpenAI runtime", () => {
    const config = resolveOpenVikingEnv({
      OPENVIKING_ENABLED: "true",
      OPENVIKING_PROVIDER: "openai",
      OPENVIKING_MODEL_API_KEY: "knowledge-only-key",
      OPENAI_API_KEY: "",
    });

    expect(config.hasModelCredentials).toBe(true);
  });
});

describe("OpenViking client", () => {
  it("parses the raw /health payload", async () => {
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      fetchImpl: async () =>
        new Response(JSON.stringify({ status: "ok", healthy: true, version: "v-test" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(client.health()).resolves.toEqual({
      status: "ok",
      healthy: true,
      version: "v-test",
    });
  });

  it("sends the recursive flag when removing a resource directory", async () => {
    let requestUrl = "";
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      fetchImpl: async (input) => {
        requestUrl = String(input);
        return new Response(JSON.stringify({ status: "ok", result: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    await client.remove("viking://resources/delegate/asset.md", true);

    const request = new URL(requestUrl);
    expect(request.pathname).toBe("/api/v1/fs");
    expect(request.searchParams.get("recursive")).toBe("true");
  });

  it("lets a blocking resource import use its declared processing timeout", async () => {
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      timeoutMs: 5,
      fetchImpl: async (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(
              new Response(JSON.stringify({ status: "ok", result: { status: "processed" } }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            );
          }, 20);

          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    });

    await expect(
      client.addResource({
        tempFileId: "temp-resource",
        to: "viking://resources/delegate/test.md",
        reason: "Regression test",
        wait: true,
        timeout: 1,
      }),
    ).resolves.toMatchObject({ status: "processed" });
  });

  it.each([
    "viking://user/memories/delegate/legacy/contact/memory.md",
    "viking://resources/delegate/../user/memories/memory.md",
    "viking://resources/delegate/%2e%2e/user/memories/memory.md",
    "viking://resources/delegate\\user\\memories\\memory.md",
    "viking://resources//delegate/test.md",
    "viking://resources/delegate/test.md?scope=user",
    "viking://resources/delegate/{env:MEMORY_ROOT}/memory.md",
  ])("rejects a non-canonical resource target before issuing a request: %s", async (to) => {
    const fetchImpl = vi.fn();
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      fetchImpl,
    });

    await expect(client.addResource({
      tempFileId: "temp-memory",
      to,
      reason: "legacy direct memory write",
    })).rejects.toThrow("canonical viking://resources/ URI");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
