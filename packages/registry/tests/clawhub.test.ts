import { describe, expect, it } from "vitest";

import {
  ClawHubRequestError,
  fetchClawHubRepresentativeSkill,
  resolveClawHubBaseUrl,
  searchClawHubRepresentativeSkills,
} from "../src/index";

describe("resolveClawHubBaseUrl", () => {
  it("uses the default registry URL", () => {
    expect(resolveClawHubBaseUrl()).toBe("https://clawhub.ai");
  });

  it("normalizes trailing slashes", () => {
    expect(resolveClawHubBaseUrl("https://clawhub.ai/")).toBe("https://clawhub.ai");
  });

  it("rejects insecure, credentialed, path-based, and non-allowlisted origins", () => {
    expect(() => resolveClawHubBaseUrl("http://clawhub.ai")).toThrow(
      "credential-free HTTPS origin",
    );
    expect(() =>
      resolveClawHubBaseUrl("https://user:secret@clawhub.ai")
    ).toThrow("credential-free HTTPS origin");
    expect(() => resolveClawHubBaseUrl("https://clawhub.ai/registry")).toThrow(
      "credential-free HTTPS origin",
    );
    expect(() => resolveClawHubBaseUrl("https://registry.internal")).toThrow(
      "host is not allowlisted",
    );
  });
});

describe("searchClawHubRepresentativeSkills", () => {
  it("maps search results into non-privileged skill packs", async () => {
    let redirect: RequestRedirect | undefined;
    const results = await searchClawHubRepresentativeSkills({
      query: "qualification",
      fetchImpl: async (_input, init) => {
        redirect = init?.redirect;
        return new Response(
          JSON.stringify({
            results: [
              {
                score: 0.88,
                slug: "lead-qualification-pro",
                displayName: "Lead Qualification Pro",
                summary: "Collects structured lead intake.",
                version: "0.3.0",
              },
            ],
          }),
        );
      },
    });

    expect(redirect).toBe("error");
    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe("clawhub");
    expect(results[0]?.enabled).toBe(false);
    expect(results[0]?.executesCode).toBe(false);
  });

  it("falls back to list mode when no search query is provided", async () => {
    const results = await searchClawHubRepresentativeSkills({
      query: "",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                slug: "founder-faq",
                displayName: "Founder FAQ",
                summary: "Answers frequent founder questions.",
                latestVersion: {
                  version: "1.2.0",
                  createdAt: 2,
                },
                createdAt: 1,
                updatedAt: 2,
              },
            ],
          }),
        ),
    });

    expect(results[0]?.slug).toBe("founder-faq");
    expect(results[0]?.version).toBe("1.2.0");
  });

  it("accepts the registry's nullable search version as unavailable metadata", async () => {
    const results = await searchClawHubRepresentativeSkills({
      query: "browser",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                score: 0.77,
                slug: "browser-automation",
                displayName: "Browser Automation",
                summary: "Browser metadata discovered from ClawHub.",
                version: null,
                ownerHandle: "community-builder",
              },
            ],
          }),
        ),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.slug).toBe("@community-builder/browser-automation");
    expect(results[0]?.ownerHandle).toBe("community-builder");
    expect(results[0]?.sourceUrl).toBe(
      "https://clawhub.ai/community-builder/skills/browser-automation",
    );
    expect(results[0]?.version).toBeUndefined();
    expect(results[0]?.enabled).toBe(false);
  });
});

describe("fetchClawHubRepresentativeSkill", () => {
  it("does not treat catalog tags as verification or runtime capabilities", async () => {
    const skill = await fetchClawHubRepresentativeSkill({
      slug: "lead-qualification-pro",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            skill: {
              slug: "lead-qualification-pro",
              displayName: "Lead Qualification Pro",
              summary: "Collects structured lead intake.",
              tags: {
                verified: "true",
                intake: "true",
              },
              createdAt: 1,
              updatedAt: 2,
            },
            latestVersion: {
              version: "0.3.0",
              createdAt: 2,
            },
            owner: {
              handle: "community-builder",
            },
          }),
        ),
    });

    expect(skill?.slug).toBe("lead-qualification-pro");
    expect(skill?.verificationTier).toBeUndefined();
    expect(skill?.capabilityTags).toEqual([]);
    expect(skill?.registryTrust.metadataOnlyAutoUpdateEligible).toBe(false);
  });

  it("preserves complete registry provenance without inventing verification", async () => {
    const skill = await fetchClawHubRepresentativeSkill({
      slug: "signed-skill",
      fetchImpl: async () => new Response(JSON.stringify({
        skill: {
          slug: "signed-skill",
          displayName: "Signed Skill",
          createdAt: 1,
          updatedAt: 2,
        },
        latestVersion: { version: "1.0.1", createdAt: 2 },
        provenance: {
          signature: { algorithm: "ed25519", keyId: "publisher-1", value: "c2ln" },
          sbomUrl: "https://registry.example/sbom.json",
          attestationUrl: "http://insecure.example/attestation.json",
        },
      })),
    });

    expect(skill?.registryProvenance).toEqual({
      signature: { algorithm: "ed25519", keyId: "publisher-1", value: "c2ln" },
      sbomUrl: "https://registry.example/sbom.json",
    });
  });

  it("drops credentialed provenance URLs at the registry boundary", async () => {
    const skill = await fetchClawHubRepresentativeSkill({
      slug: "credentialed-provenance",
      fetchImpl: async () => new Response(JSON.stringify({
        skill: {
          slug: "credentialed-provenance",
          displayName: "Credentialed Provenance",
          createdAt: 1,
          updatedAt: 2,
        },
        latestVersion: { version: "1.0.1", createdAt: 2 },
        provenance: {
          sbomUrl: "https://user:secret@registry.example/sbom.json",
          attestationUrl: "https://token@registry.example/attestation.json",
        },
      })),
    });

    expect(skill?.registryProvenance).toBeUndefined();
  });

  it("drops oversized signature fields at the registry boundary", async () => {
    const skill = await fetchClawHubRepresentativeSkill({
      slug: "oversized-signature",
      fetchImpl: async () => new Response(JSON.stringify({
        skill: {
          slug: "oversized-signature",
          displayName: "Oversized Signature",
          createdAt: 1,
          updatedAt: 2,
        },
        latestVersion: { version: "1.0.1", createdAt: 2 },
        provenance: {
          signature: { algorithm: "ed25519", keyId: "publisher-1", value: "x".repeat(513) },
        },
      })),
    });

    expect(skill?.registryProvenance).toBeUndefined();
  });

  it("throws a typed request error on non-200 responses", async () => {
    await expect(
      fetchClawHubRepresentativeSkill({
        slug: "missing",
        fetchImpl: async () => new Response("nope", { status: 404, statusText: "Not Found" }),
      }),
    ).rejects.toBeInstanceOf(ClawHubRequestError);
  });

  it("does not guess a publisher when the registry reports an ambiguous bare slug", async () => {
    const requests: URL[] = [];
    await expect(
      fetchClawHubRepresentativeSkill({
        slug: "shared-skill",
        fetchImpl: async (input) => {
          requests.push(new URL(String(input)));
          return new Response(
            JSON.stringify({
              code: "AMBIGUOUS_SKILL_SLUG",
              slug: "shared-skill",
              matches: [
                { ownerHandle: "publisher-a" },
                { ownerHandle: "publisher-b" },
              ],
            }),
            { status: 409, statusText: "Conflict" },
          );
        },
      }),
    ).rejects.toMatchObject({
      name: "ClawHubRequestError",
      status: 409,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/api/v1/skills/shared-skill");
    expect(requests[0]?.searchParams.has("owner")).toBe(false);
  });

  it("rejects scoped references with trailing punctuation or oversized owners before fetch", async () => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return new Response("{}");
    };

    await expect(fetchClawHubRepresentativeSkill({
      slug: "@publisher-/shared-skill",
      fetchImpl,
    })).rejects.toThrow("owner handle is invalid");
    await expect(fetchClawHubRepresentativeSkill({
      slug: `@${"a".repeat(65)}/shared-skill`,
      fetchImpl,
    })).rejects.toThrow("slug is invalid");
    expect(fetchCalls).toBe(0);
  });

  it("rejects malformed registry metadata before it crosses the persistence boundary", async () => {
    await expect(
      fetchClawHubRepresentativeSkill({
        slug: "malformed",
        fetchImpl: async () => new Response(JSON.stringify({
          skill: {
            slug: "malformed",
            displayName: 42,
            createdAt: 1,
            updatedAt: 2,
          },
        })),
      }),
    ).rejects.toThrow();
  });
});
