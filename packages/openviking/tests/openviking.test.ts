import { describe, expect, it } from "vitest";

import {
  buildCollectorMemoryDocument,
  buildDelegateSessionKey,
  OpenVikingClient,
  buildRepresentativeContactMemoryRootUri,
  buildRepresentativeKnowledgeDocuments,
  buildRepresentativeResourceRootUri,
  buildSessionScopedSearchRoot,
  isPublicSafeText,
  resolveOpenVikingEnv,
  sanitizePublicSafeText,
} from "../src/index";

describe("OpenViking URI strategy", () => {
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

  it("returns resource, contact memory, and agent memory search roots in order", () => {
    expect(
      buildSessionScopedSearchRoot({
        representativeSlug: "lin-founder-rep",
        contactId: "contact_a",
      }),
    ).toEqual([
      "viking://resources/delegate/reps/lin-founder-rep/",
      "viking://user/memories/delegate/lin-founder-rep/contact_a/",
      "viking://agent/memories/delegate/lin-founder-rep/",
    ]);
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
    expect(docs[0]?.uri).toContain("/identity/");
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
    expect(config.autoCaptureDefault).toBe(true);
    expect(config.autoRecallDefault).toBe(true);
    expect(config.embeddingDimension).toBe(3072);
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
