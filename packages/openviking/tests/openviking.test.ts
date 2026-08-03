import { describe, expect, it } from "vitest";

import {
  buildCollectorMemoryDocument,
  buildDelegateSessionKey,
  buildGovernedContactChannelMemoryRootUri,
  buildGovernedContactChannelMemoryVersionUri,
  buildGovernedRepresentativeExperienceRootUri,
  buildGovernedRepresentativeExperienceVersionUri,
  OpenVikingClient,
  buildRepresentativeContactMemoryRootUri,
  buildRepresentativeKnowledgeDocuments,
  buildRepresentativeKnowledgeRootUri,
  buildRepresentativeResourceRootUri,
  buildRepresentativeVersionResourceRootUri,
  buildSessionScopedSearchRoot,
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

  it("builds contact-scoped memory roots without cross-contact overlap", () => {
    const a = buildRepresentativeContactMemoryRootUri("lin-founder-rep", "contact_a");
    const b = buildRepresentativeContactMemoryRootUri("lin-founder-rep", "contact_b");

    expect(a).not.toBe(b);
    expect(a).toContain("/contact_a/");
    expect(b).toContain("/contact_b/");
  });

  it("builds deterministic session keys", () => {
    expect(
      buildDelegateSessionKey({
        representativeSlug: "lin-founder-rep",
        chatId: 12345,
        contactId: "contact_a",
      }),
    ).toBe("delegate:tg:lin-founder-rep:12345:contact_a");
  });

  it("returns pinned resources, approved knowledge, and current-contact memory roots", () => {
    expect(
      buildSessionScopedSearchRoot({
        representativeSlug: "lin-founder-rep",
        representativeVersionId: "version_7",
        contactId: "contact_a",
      }),
    ).toEqual([
      "viking://resources/delegate/reps/lin-founder-rep/versions/version_7/",
      "viking://resources/delegate/reps/lin-founder-rep/knowledge/",
      "viking://user/memories/delegate/lin-founder-rep/contact_a/",
    ]);
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

  it("creates collector memory docs only for public-safe content", () => {
    const doc = buildCollectorMemoryDocument({
      representativeSlug: "lin-founder-rep",
      contactId: "contact_a",
      collectorKind: "quote",
      key: "quote_1",
      title: "Quote intake",
      summary: "The contact needs a fast quote for a founder sprint.",
      lines: ["Budget: 8k USD", "Timeline: next month"],
    });

    expect(doc?.uri).toContain("contact_a/events/quote_1.md");
    expect(doc?.content).toContain("Budget: 8k USD");
    expect(doc?.content).toContain("Timeline: next month");

    const unsafe = buildCollectorMemoryDocument({
      representativeSlug: "lin-founder-rep",
      contactId: "contact_a",
      collectorKind: "quote",
      key: "quote_2",
      title: "Unsafe",
      summary: "Their password is 123456 and should not be stored.",
      lines: [],
    });

    expect(unsafe).toBeNull();
  });

  it("drops unsafe collector lines even when the summary is safe", () => {
    const doc = buildCollectorMemoryDocument({
      representativeSlug: "lin-founder-rep",
      contactId: "contact_a",
      collectorKind: "quote",
      key: "quote_3",
      title: "Quote intake",
      summary: "The contact needs a quote for a workshop.",
      lines: [
        "Budget: 5k USD",
        "Password: hunter2",
      ],
    });

    expect(doc?.content).toContain("Budget: 5k USD");
    expect(doc?.content).not.toContain("Password: hunter2");
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
});
