import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  assertExactOpenVikingResourceLeaf,
  assertExactOpenVikingResourceRootUri,
  assertExactGovernedMemoryRootUri,
  assertExactGovernedMemoryVersionUri,
  buildGovernedContactChannelMemoryRootUri,
  buildGovernedContactChannelMemoryVersionUri,
  buildGovernedMemoryManagedUserId,
  buildGovernedRepresentativeExperienceRootUri,
  buildGovernedRepresentativeExperienceVersionUri,
  buildGovernedSharedContactMemoryRootUri,
  buildGovernedSharedContactMemoryVersionUri,
  GovernedMemoryRootProvisionError,
  GovernedMemoryUnsupportedError,
  ExactResourceUnsupportedError,
  ExactResourceRootProvisionError,
  OpenVikingClient,
  buildRepresentativeKnowledgeDocuments,
  buildRepresentativeKnowledgeRootUri,
  buildRepresentativeResourceRootUri,
  buildRepresentativeVersionResourceRootUri,
  buildRepresentativeVersionKnowledgeAssetUri,
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
      "viking://user/delegate-memory-Rep_Namespace_A/memories/delegate/Rep_Namespace_A/contacts/Contact_A/channels/matrix/memories/Memory_A/versions/Version_A.md",
    );
    expect(versionA).not.toBe(versionB);
  });

  it("isolates shared contact memory by representative namespace and canonical identity", () => {
    const root = buildGovernedSharedContactMemoryRootUri({
      namespaceKey: "rep_namespace_a",
      audienceIdentityId: "identity_a",
    });
    const version = buildGovernedSharedContactMemoryVersionUri({
      namespaceKey: "rep_namespace_a",
      audienceIdentityId: "identity_a",
      memoryId: "memory_a",
      memoryVersionId: "version_a",
    });

    expect(root).toBe(
      "viking://user/delegate-memory-rep_namespace_a/memories/delegate/rep_namespace_a/audience-identities/identity_a/contact-memory/",
    );
    expect(version).toBe(`${root}memories/memory_a/versions/version_a.md`);
    expect(buildGovernedSharedContactMemoryRootUri({
      namespaceKey: "rep_namespace_b",
      audienceIdentityId: "identity_a",
    })).not.toBe(root);
    expect(buildGovernedSharedContactMemoryRootUri({
      namespaceKey: "rep_namespace_a",
      audienceIdentityId: "identity_b",
    })).not.toBe(root);
    expect(assertExactGovernedMemoryRootUri({
      namespaceKey: "rep_namespace_a",
      uri: root,
    })).toMatchObject({
      kind: "contact_shared",
      audienceIdentityId: "identity_a",
      rootUri: root,
    });
    expect(assertExactGovernedMemoryVersionUri({
      namespaceKey: "rep_namespace_a",
      uri: version,
    })).toMatchObject({
      kind: "contact_shared",
      audienceIdentityId: "identity_a",
      memoryId: "memory_a",
      memoryVersionId: "version_a",
      rootUri: root,
    });
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
    expect(() =>
      buildGovernedSharedContactMemoryRootUri({
        namespaceKey: "rep_namespace_a",
        audienceIdentityId: "identity/a",
      }),
    ).toThrow("Invalid governed memory audienceIdentityId");
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
      "viking://user/delegate-memory-rep_namespace_a/memories/delegate/rep_namespace_a/representative-experience/",
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

  it("derives the managed OpenViking user from the locked namespace key", () => {
    expect(buildGovernedMemoryManagedUserId("Rep_Namespace_A")).toBe(
      "delegate-memory-Rep_Namespace_A",
    );
  });

  it("validates only exact governed roots and immutable leaves", () => {
    const namespaceKey = "rep_namespace_a";
    const root = buildGovernedContactChannelMemoryRootUri({
      namespaceKey,
      contactId: "contact_a",
      channel: "web",
    });
    const version = buildGovernedContactChannelMemoryVersionUri({
      namespaceKey,
      contactId: "contact_a",
      channel: "web",
      memoryId: "memory_a",
      memoryVersionId: "version_a",
    });

    expect(assertExactGovernedMemoryRootUri({ namespaceKey, uri: root })).toMatchObject({
      kind: "contact",
      rootUri: root,
      userId: "delegate-memory-rep_namespace_a",
    });
    expect(assertExactGovernedMemoryVersionUri({ namespaceKey, uri: version })).toMatchObject({
      kind: "contact",
      rootUri: root,
      uri: version,
      memoryId: "memory_a",
      memoryVersionId: "version_a",
    });
  });

  it.each([
    "viking://user/memories/delegate/rep_namespace_a/contacts/contact_a/channels/web/",
    "viking://agent/memories/delegate/rep_namespace_a/representative-experience/",
    "viking://user/delegate-memory-other/memories/delegate/rep_namespace_a/contacts/contact_a/channels/web/",
    "viking://user/delegate-memory-rep_namespace_a/memories/delegate/rep_namespace_a/contacts/../channels/web/",
    "viking://user/delegate-memory-rep_namespace_a/memories/delegate/rep_namespace_a/contacts/%63ontact_a/channels/web/",
    "viking://user/delegate-memory-rep_namespace_a/memories/delegate/rep_namespace_a/contacts/contact_a\\channels\\web/",
    "viking://user/delegate-memory-rep_namespace_a/memories/delegate/rep_namespace_a/contacts/contact_a/channels/web/?scope=other",
  ])("rejects a non-exact governed root: %s", (uri) => {
    expect(() =>
      assertExactGovernedMemoryRootUri({ namespaceKey: "rep_namespace_a", uri }),
    ).toThrow("exact canonical managed-user root or immutable version leaf");
  });

  it("rejects immutable-leaf suffix spoofing and non-terminal dots", () => {
    const version = buildGovernedRepresentativeExperienceVersionUri({
      namespaceKey: "rep_namespace_a",
      memoryId: "memory_a",
      memoryVersionId: "version_a",
    });

    for (const uri of [
      `${version}/spoofed-child.md`,
      `${version}.bak`,
      version.replace("version_a.md", "version.a.md"),
      `${version}?other=true`,
    ]) {
      expect(() =>
        assertExactGovernedMemoryVersionUri({ namespaceKey: "rep_namespace_a", uri }),
      ).toThrow("exact canonical managed-user root or immutable version leaf");
    }
  });

  it("rejects non-canonical shared roots and exposes identity for caller authorization", () => {
    const root = buildGovernedSharedContactMemoryRootUri({
      namespaceKey: "rep_namespace_a",
      audienceIdentityId: "identity_a",
    });
    const version = buildGovernedSharedContactMemoryVersionUri({
      namespaceKey: "rep_namespace_a",
      audienceIdentityId: "identity_a",
      memoryId: "memory_a",
      memoryVersionId: "version_a",
    });
    for (const uri of [
      root.replace("identity_a", "../identity_a"),
      root.replace("identity_a", "%69dentity_a"),
      `${root}child/`,
    ]) {
      expect(() => assertExactGovernedMemoryRootUri({
        namespaceKey: "rep_namespace_a",
        uri,
      })).toThrow("exact canonical managed-user root or immutable version leaf");
    }
    expect(assertExactGovernedMemoryVersionUri({
      namespaceKey: "rep_namespace_a",
      uri: version.replace("identity_a", "identity_b"),
    })).toMatchObject({ audienceIdentityId: "identity_b" });
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
    expect(buildRepresentativeVersionKnowledgeAssetUri(
      "lin-founder-rep",
      "version_7",
      "asset_9",
    )).toBe(
      "viking://resources/delegate/reps/lin-founder-rep/versions/version_7/knowledge/asset_9.md",
    );
  });

  it("accepts only exact immutable leaves below a pinned version root", () => {
    const rootUri = buildRepresentativeVersionResourceRootUri("lin-founder-rep", "version_7");
    const uri = buildRepresentativeVersionKnowledgeAssetUri(
      "lin-founder-rep",
      "version_7",
      "asset_9",
    );
    expect(() => assertExactOpenVikingResourceLeaf({ rootUri, uri })).not.toThrow();
    for (const invalidUri of [
      rootUri,
      `${rootUri}knowledge-assets/`,
      buildRepresentativeVersionKnowledgeAssetUri("other-rep", "version_7", "asset_9"),
      `${uri}?other=true`,
    ]) {
      expect(() => assertExactOpenVikingResourceLeaf({ rootUri, uri: invalidUri })).toThrow();
    }
    expect(() => assertExactOpenVikingResourceRootUri(rootUri)).not.toThrow();
    expect(() => assertExactOpenVikingResourceRootUri(uri)).toThrow(
      "canonical non-root directory URI",
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
      handoffWindowHours: 24,
      skills: ["faq_reply", "human_handoff"],
      knowledgePack: {
        identitySummary: "Public identity summary.",
        faq: [{ title: "What do you do?", summary: "We help founders." }],
        materials: [{ title: "Deck", summary: "Public deck", url: "https://example.com/deck" }],
        policies: [{ title: "Boundary", summary: "No private access." }],
      },
      handoffPrompt: "Please share fit, budget, and timing.",
    });

    expect(docs).toHaveLength(4);
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

  it("creates and reads one exact published-version resource without upload fallback", async () => {
    const rootUri = buildRepresentativeVersionResourceRootUri("delegate", "version_1");
    const uri = buildRepresentativeVersionKnowledgeAssetUri(
      "delegate",
      "version_1",
      "asset_1",
    );
    const content = "# Published asset\n\nAuthoritative PostgreSQL snapshot.";
    const contentHash = sha256(content);
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "",
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        const request = new URL(String(input));
        if (request.pathname === "/api/v1/content/batch-write") {
          return okResponse({
            root_uri: rootUri.slice(0, -1),
            created: [uri],
            updated: [],
            unchanged: [],
          });
        }
        return okResponse(content);
      },
    });

    await expect(client.createExactResource({
      rootUri,
      uri,
      content,
      contentHash,
    })).resolves.toEqual({
      rootUri,
      uri,
      contentHash,
      outcome: "created",
    });
    await expect(client.readExactResource({ rootUri, uri })).resolves.toEqual({
      uri,
      content,
      contentHash,
    });
    expect(requests).toEqual([
      {
        url: "http://openviking.test/api/v1/content/batch-write",
        method: "POST",
        body: {
          root_uri: rootUri.slice(0, -1),
          operations: [{
            uri,
            content,
            precondition: { kind: "create_if_absent" },
          }],
          wait: true,
        },
      },
      {
        url: `http://openviking.test/api/v1/content/read?uri=${encodeURIComponent(uri)}&offset=0&limit=-1&raw=true`,
        method: "GET",
      },
    ]);
  });

  it("provisions and verifies the exact published-version resource root", async () => {
    const rootUri = buildRepresentativeVersionResourceRootUri("delegate", "version_1");
    const transportRootUri = rootUri.slice(0, -1);
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      fetchImpl: async (input, init) => {
        requests.push({
          method: init?.method ?? "",
          url: String(input),
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        const request = new URL(String(input));
        return request.pathname === "/api/v1/fs/mkdir"
          ? okResponse({ uri: transportRootUri })
          : okResponse({ uri: transportRootUri, isDir: true });
      },
    });
    await expect(client.ensureExactResourceRoot(rootUri)).resolves.toEqual({ rootUri });
    expect(requests).toEqual([
      {
        method: "POST",
        url: "http://openviking.test/api/v1/fs/mkdir",
        body: { uri: transportRootUri },
      },
      {
        method: "GET",
        url: `http://openviking.test/api/v1/fs/stat?uri=${encodeURIComponent(transportRootUri)}`,
      },
    ]);
  });

  it("accepts a root mkdir conflict only after exact stat verification", async () => {
    const rootUri = buildRepresentativeVersionResourceRootUri("delegate", "version_1");
    const transportRootUri = rootUri.slice(0, -1);
    let requestCount = 0;
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      fetchImpl: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Response(JSON.stringify({
            status: "error",
            error: { code: "CONFLICT", message: "already exists" },
          }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          });
        }
        return okResponse({ uri: transportRootUri, isDir: true });
      },
    });
    await expect(client.ensureExactResourceRoot(rootUri)).resolves.toEqual({ rootUri });
    expect(requestCount).toBe(2);
  });

  it("fails closed on unsupported, mismatched, or non-directory exact roots", async () => {
    const rootUri = buildRepresentativeVersionResourceRootUri("delegate", "version_1");
    const unsupportedClient = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      fetchImpl: async () => new Response(null, { status: 501 }),
    });
    await expect(unsupportedClient.ensureExactResourceRoot(rootUri)).rejects.toMatchObject({
      code: "EXACT_RESOURCE_ROOT_PROVISION_UNSUPPORTED",
      stage: "mkdir",
    });

    for (const stat of [
      { uri: `${rootUri.slice(0, -1)}-other`, isDir: true },
      { uri: rootUri.slice(0, -1), isDir: false },
    ]) {
      let requestCount = 0;
      const client = new OpenVikingClient({
        baseUrl: "http://openviking.test",
        fetchImpl: async () => {
          requestCount += 1;
          return requestCount === 1
            ? okResponse({ uri: rootUri.slice(0, -1) })
            : okResponse(stat);
        },
      });
      const error = await client.ensureExactResourceRoot(rootUri).catch(
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(ExactResourceRootProvisionError);
      expect(error).toMatchObject({
        code: "EXACT_RESOURCE_ROOT_PROVISION_FAILED",
        stage: "verify",
      });
    }
  });

  it.each([404, 405, 501])(
    "fails closed when exact resource batch-write is unsupported (%s)",
    async (status) => {
      const rootUri = buildRepresentativeVersionResourceRootUri("delegate", "version_1");
      const uri = `${rootUri}faq/index.md`;
      const content = "# FAQ";
      const client = new OpenVikingClient({
        baseUrl: "http://openviking.test",
        fetchImpl: async () => new Response(null, { status }),
      });
      const error = await client.createExactResource({
        rootUri,
        uri,
        content,
        contentHash: sha256(content),
      }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ExactResourceUnsupportedError);
      expect(error).toMatchObject({
        status,
        code: "EXACT_RESOURCE_BATCH_WRITE_UNSUPPORTED",
        capabilityStatus: "degraded",
      });
    },
  );

  it("provisions only an exact governed-memory root and verifies it with stat", async () => {
    const namespaceKey = "memory_namespace_a";
    const userId = buildGovernedMemoryManagedUserId(namespaceKey);
    const rootUri = buildGovernedContactChannelMemoryRootUri({
      namespaceKey,
      contactId: "contact_a",
      channel: "matrix",
    });
    const transportRootUri = rootUri.slice(0, -1);
    const requests: Array<{
      method: string;
      url: string;
      body?: unknown;
      user: string | null;
    }> = [];
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId,
      fetchImpl: async (input, init) => {
        requests.push({
          method: init?.method ?? "",
          url: String(input),
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
          user: new Headers(init?.headers).get("X-OpenViking-User"),
        });
        const request = new URL(String(input));
        if (request.pathname === "/api/v1/fs/mkdir") {
          return okResponse({ uri: transportRootUri });
        }
        return okResponse({
          uri: transportRootUri,
          name: "matrix",
          isDir: true,
        });
      },
    });

    await expect(client.ensureGovernedMemoryRoot({
      namespaceKey,
      uri: rootUri,
    })).resolves.toEqual({ rootUri, outcome: "ready" });
    expect(requests).toEqual([
      {
        method: "POST",
        url: "http://openviking.test/api/v1/fs/mkdir",
        body: { uri: transportRootUri },
        user: userId,
      },
      {
        method: "GET",
        url: `http://openviking.test/api/v1/fs/stat?uri=${encodeURIComponent(transportRootUri)}`,
        user: userId,
      },
    ]);
  });

  it("treats a concurrent mkdir conflict as success only after exact stat verification", async () => {
    const fixture = governedMemoryClientFixture();
    const transportRootUri = fixture.rootUri.slice(0, -1);
    let requestCount = 0;
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: fixture.userId,
      fetchImpl: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Response(JSON.stringify({
            status: "error",
            error: { code: "CONFLICT", message: "directory already exists" },
          }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          });
        }
        return okResponse({ uri: transportRootUri, isDir: true });
      },
    });

    await expect(client.ensureGovernedMemoryRoot({
      namespaceKey: fixture.write.namespaceKey,
      uri: fixture.rootUri,
    })).resolves.toEqual({ rootUri: fixture.rootUri, outcome: "ready" });
    expect(requestCount).toBe(2);
  });

  it("classifies unsupported mkdir and failed directory verification consistently", async () => {
    const fixture = governedMemoryClientFixture();
    const unsupportedClient = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: fixture.userId,
      fetchImpl: async () => new Response(null, { status: 501 }),
    });
    const unsupported = await unsupportedClient.ensureGovernedMemoryRoot({
      namespaceKey: fixture.write.namespaceKey,
      uri: fixture.rootUri,
    }).catch((reason: unknown) => reason);
    expect(unsupported).toBeInstanceOf(GovernedMemoryRootProvisionError);
    expect(unsupported).toMatchObject({
      status: 501,
      code: "GOVERNED_MEMORY_ROOT_PROVISION_UNSUPPORTED",
      failure: "unsupported",
      stage: "mkdir",
      capabilityStatus: "degraded",
    });

    let requestCount = 0;
    const fileAtRootClient = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: fixture.userId,
      fetchImpl: async () => {
        requestCount += 1;
        return requestCount === 1
          ? okResponse({ uri: fixture.rootUri.slice(0, -1) })
          : okResponse({ uri: fixture.rootUri.slice(0, -1), isDir: false });
      },
    });
    const verificationFailure = await fileAtRootClient.ensureGovernedMemoryRoot({
      namespaceKey: fixture.write.namespaceKey,
      uri: fixture.rootUri,
    }).catch((reason: unknown) => reason);
    expect(verificationFailure).toBeInstanceOf(GovernedMemoryRootProvisionError);
    expect(verificationFailure).toMatchObject({
      status: 409,
      code: "GOVERNED_MEMORY_ROOT_PROVISION_FAILED",
      failure: "verification_failed",
      stage: "verify",
    });
  });

  it("rejects cross-scope and non-root provisioning targets before mkdir", async () => {
    const fixture = governedMemoryClientFixture();
    const fetchImpl = vi.fn();
    const wrongScopeClient = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: "delegate-memory-another_namespace",
      fetchImpl,
    });
    await expect(wrongScopeClient.ensureGovernedMemoryRoot({
      namespaceKey: fixture.write.namespaceKey,
      uri: fixture.rootUri,
    })).rejects.toThrow("client scope does not match");

    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: fixture.userId,
      fetchImpl,
    });
    for (const uri of [
      fixture.rootUri.replace("viking://user/", "viking://agent/"),
      `${fixture.rootUri}nested/`,
      fixture.uri,
    ]) {
      await expect(client.ensureGovernedMemoryRoot({
        namespaceKey: fixture.write.namespaceKey,
        uri,
      })).rejects.toThrow("exact canonical managed-user root or immutable version leaf");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("creates one governed memory version with exact safeText bytes", async () => {
    const namespaceKey = "memory_namespace_a";
    const userId = buildGovernedMemoryManagedUserId(namespaceKey);
    const uri = buildGovernedContactChannelMemoryVersionUri({
      namespaceKey,
      contactId: "contact_a",
      channel: "telegram",
      memoryId: "memory_a",
      memoryVersionId: "version_a",
    });
    const rootUri = buildGovernedContactChannelMemoryRootUri({
      namespaceKey,
      contactId: "contact_a",
      channel: "telegram",
    });
    const safeText = "Preference: reply_length=detailed\n\n  Keep this spacing.\n";
    const contentHash = sha256(safeText);
    let requestBody: unknown;
    let requestUser = "";
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId,
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        requestUser = new Headers(init?.headers).get("X-OpenViking-User") ?? "";
        return okResponse({
          root_uri: rootUri.slice(0, -1),
          created: [uri],
          updated: [],
          unchanged: [],
        });
      },
    });

    await expect(client.createGovernedMemoryVersion({
      namespaceKey,
      uri,
      safeText,
      contentHash,
    })).resolves.toEqual({
      uri,
      rootUri,
      contentHash,
      outcome: "created",
    });
    expect(requestUser).toBe(userId);
    expect(requestBody).toEqual({
      root_uri: rootUri.slice(0, -1),
      operations: [
        {
          uri,
          content: safeText,
          precondition: { kind: "create_if_absent" },
        },
      ],
      wait: true,
    });
  });

  it("accepts an unchanged idempotent governed memory write", async () => {
    const fixture = governedMemoryClientFixture();
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: fixture.userId,
      fetchImpl: async () => okResponse({
        root_uri: fixture.rootUri.slice(0, -1),
        created: [],
        updated: [],
        unchanged: [fixture.uri],
      }),
    });

    await expect(client.createGovernedMemoryVersion(fixture.write)).resolves.toMatchObject({
      uri: fixture.uri,
      outcome: "unchanged",
    });
  });

  it("uses the v0.4.12 wait and timeout fields for governed memory writes", async () => {
    const fixture = governedMemoryClientFixture();
    let requestBody: unknown;
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      timeoutMs: 50,
      userId: fixture.userId,
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return okResponse({
          root_uri: fixture.rootUri.slice(0, -1),
          created: [fixture.uri],
          updated: [],
          unchanged: [],
          queue_status: {},
        });
      },
    });

    await expect(client.createGovernedMemoryVersion({
      ...fixture.write,
      timeoutSeconds: 12,
    })).resolves.toMatchObject({ outcome: "created" });
    expect(requestBody).toEqual({
      root_uri: fixture.rootUri.slice(0, -1),
      operations: [
        {
          uri: fixture.uri,
          content: fixture.write.safeText,
          precondition: { kind: "create_if_absent" },
        },
      ],
      wait: true,
      timeout: 12,
    });
  });

  it.each([404, 405, 501])(
    "fails closed with a governed-memory degraded error when batch-write returns %s",
    async (status) => {
      const fixture = governedMemoryClientFixture();
      const fetchImpl = vi.fn(async (_input: string | URL | Request) => {
        if (status === 404) {
          return new Response("<html>route not found</html>", {
            status,
            headers: { "Content-Type": "text/html" },
          });
        }
        if (status === 405) {
          return new Response(JSON.stringify({ detail: "Method Not Allowed" }), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(null, { status });
      });
      const client = new OpenVikingClient({
        baseUrl: "http://openviking.test",
        userId: fixture.userId,
        fetchImpl,
      });

      const error = await client.createGovernedMemoryVersion(fixture.write).catch(
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(GovernedMemoryUnsupportedError);
      expect(error).toMatchObject({
        status,
        code: "GOVERNED_MEMORY_BATCH_WRITE_UNSUPPORTED",
        capability: "content.batch-write",
        capabilityStatus: "degraded",
      });
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining("no unsafe content/write fallback was attempted"),
      );
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
        "http://openviking.test/api/v1/content/batch-write",
      );
    },
  );

  it("preserves a governed memory batch-write conflict as HTTP 409", async () => {
    const fixture = governedMemoryClientFixture();
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: fixture.userId,
      fetchImpl: async () => new Response(JSON.stringify({
        status: "error",
        error: { code: "CONFLICT", message: "already exists with different bytes" },
      }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    });

    await expect(client.createGovernedMemoryVersion(fixture.write)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rejects a malformed successful batch-write result after the request was dispatched", async () => {
    const fixture = governedMemoryClientFixture();
    const fetchImpl = vi.fn(async () => okResponse({
      root_uri: fixture.rootUri.slice(0, -1),
      created: [],
      updated: [],
      unchanged: [],
    }));
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: fixture.userId,
      fetchImpl,
    });

    await expect(client.createGovernedMemoryVersion(fixture.write)).rejects.toThrow(
      "invalid governed memory write result",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("preserves HTTP 200 on an invalid response envelope so execution can treat it as unconfirmed", async () => {
    const fixture = governedMemoryClientFixture();
    const fetchImpl = vi.fn(async () => new Response("not-json", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    }));
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: fixture.userId,
      fetchImpl,
    });

    await expect(client.createGovernedMemoryVersion(fixture.write)).rejects.toMatchObject({
      status: 200,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects a local content hash mismatch before issuing a request", async () => {
    const fixture = governedMemoryClientFixture();
    const fetchImpl = vi.fn();
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: fixture.userId,
      fetchImpl,
    });

    await expect(client.createGovernedMemoryVersion({
      ...fixture.write,
      contentHash: "0".repeat(64),
    })).rejects.toThrow("content hash does not match safeText");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects wrong-user, Agent, shorthand, and suffix-spoofed targets before fetch", async () => {
    const fixture = governedMemoryClientFixture();
    const fetchImpl = vi.fn();
    const wrongScopeClient = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: "delegate-memory-wrong_namespace",
      fetchImpl,
    });
    await expect(wrongScopeClient.createGovernedMemoryVersion(fixture.write)).rejects.toThrow(
      "client scope does not match",
    );

    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: fixture.userId,
      fetchImpl,
    });
    for (const uri of [
      fixture.uri.replace("viking://user/", "viking://agent/"),
      fixture.uri.replace(`viking://user/${fixture.userId}/`, "viking://user/"),
      `${fixture.uri}/spoofed-child.md`,
    ]) {
      await expect(client.createGovernedMemoryVersion({
        ...fixture.write,
        uri,
      })).rejects.toThrow("exact canonical managed-user root or immutable version leaf");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("strictly rejects a suffix-spoofed URI returned by batch-write", async () => {
    const fixture = governedMemoryClientFixture();
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: fixture.userId,
      fetchImpl: async () => okResponse({
        root_uri: fixture.rootUri.slice(0, -1),
        created: [`${fixture.uri}/spoofed-child.md`],
        updated: [],
        unchanged: [],
      }),
    });

    await expect(client.createGovernedMemoryVersion(fixture.write)).rejects.toThrow(
      "exact canonical managed-user root or immutable version leaf",
    );
  });

  it("reads the complete raw governed memory for reconciliation", async () => {
    const fixture = governedMemoryClientFixture();
    const content = "line one\n\nline three\n";
    let requestUrl = "";
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: fixture.userId,
      fetchImpl: async (input) => {
        requestUrl = String(input);
        return okResponse(content);
      },
    });

    await expect(client.readGovernedMemoryVersion({
      namespaceKey: fixture.write.namespaceKey,
      uri: fixture.uri,
    })).resolves.toEqual({
      uri: fixture.uri,
      content,
      contentHash: sha256(content),
    });
    const request = new URL(requestUrl);
    expect(request.pathname).toBe("/api/v1/content/read");
    expect(request.searchParams.get("offset")).toBe("0");
    expect(request.searchParams.get("limit")).toBe("-1");
    expect(request.searchParams.get("raw")).toBe("true");
  });

  it("deletes only an exact governed memory leaf with recursive=false", async () => {
    const fixture = governedMemoryClientFixture();
    let requestUrl = "";
    let requestMethod = "";
    const client = new OpenVikingClient({
      baseUrl: "http://openviking.test",
      userId: fixture.userId,
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestMethod = init?.method ?? "";
        return okResponse({ uri: fixture.uri });
      },
    });

    await expect(client.deleteGovernedMemoryVersion({
      namespaceKey: fixture.write.namespaceKey,
      uri: fixture.uri,
    })).resolves.toEqual({ uri: fixture.uri });
    const request = new URL(requestUrl);
    expect(requestMethod).toBe("DELETE");
    expect(request.pathname).toBe("/api/v1/fs");
    expect(request.searchParams.get("uri")).toBe(fixture.uri);
    expect(request.searchParams.get("recursive")).toBe("false");
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

function governedMemoryClientFixture() {
  const namespaceKey = "memory_namespace_a";
  const userId = buildGovernedMemoryManagedUserId(namespaceKey);
  const rootUri = buildGovernedRepresentativeExperienceRootUri(namespaceKey);
  const uri = buildGovernedRepresentativeExperienceVersionUri({
    namespaceKey,
    memoryId: "memory_a",
    memoryVersionId: "version_a",
  });
  const safeText = "Deidentified representative experience.";
  return {
    userId,
    rootUri,
    uri,
    write: {
      namespaceKey,
      uri,
      safeText,
      contentHash: sha256(safeText),
    },
  };
}

function okResponse(result: unknown): Response {
  return new Response(JSON.stringify({ status: "ok", result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
