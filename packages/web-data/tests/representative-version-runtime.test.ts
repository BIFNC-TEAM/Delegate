import { demoRepresentative } from "@delegate/domain";
import { describe, expect, it } from "vitest";

import {
  applyRepresentativeVersionSnapshot,
  resolvePublicRepresentativeAvailability,
  type RepresentativeSetupSnapshot,
} from "../src/representative-setup";

function currentDraft(): RepresentativeSetupSnapshot {
  return {
    id: demoRepresentative.id,
    slug: demoRepresentative.slug,
    ownerName: demoRepresentative.ownerName,
    name: "Unpublished draft name",
    tagline: "Unpublished draft tagline",
    tone: "draft tone",
    languages: ["zh-CN"],
    groupActivation: "always",
    publicMode: false,
    humanInLoop: false,
    skills: [...demoRepresentative.skills],
    knowledgePack: {
      identitySummary: "Unpublished draft knowledge",
      faq: [],
      materials: [],
      policies: [],
    },
    contract: {
      ...demoRepresentative.contract,
      freeScope: [...demoRepresentative.contract.freeScope],
      paywalledIntents: [...demoRepresentative.contract.paywalledIntents],
    },
    pricing: demoRepresentative.pricing.map((plan) => ({ ...plan, stars: plan.stars + 999 })),
    handoffPrompt: "Unpublished draft handoff",
    actionGate: { ...demoRepresentative.actionGate },
    compute: {
      enabled: false,
      defaultPolicyMode: "ask",
      baseImage: "debian:bookworm-slim",
      maxSessionMinutes: 15,
      autoApproveBudgetCents: 0,
      artifactRetentionDays: 14,
      networkMode: "no_network",
      networkAllowlist: [],
      filesystemMode: "workspace_only",
      capabilityModes: {
        exec: "ask",
        read: "allow",
        write: "ask",
        process: "ask",
        browser: "ask",
        mcp: "ask",
      },
    },
    delegation: {
      enabled: true,
      naturalLanguageEnabled: true,
      explicitComputeEnabled: true,
      maxSteps: 5,
      maxCostCents: 0,
      knowledgeScope: "user_input_only",
    },
  };
}

function publishedSnapshot(pricing: unknown[]) {
  return {
    identity: {
      displayName: "Published representative",
      roleSummary: "Published tagline",
      tone: "published tone",
      languages: ["en"],
    },
    publicMode: true,
    humanInLoop: true,
    conversation: {
      ...demoRepresentative.contract,
      handoffPrompt: "Published handoff",
    },
    governance: {
      allowedSkills: demoRepresentative.skills,
      actionGate: demoRepresentative.actionGate,
    },
    knowledge: {
      identitySummary: "Published knowledge",
      faq: demoRepresentative.knowledgePack.faq,
      materials: [],
      policies: [],
    },
    pricing,
  };
}

describe("representative published runtime snapshot", () => {
  it("keeps unpublished dashboard edits out of the public runtime", () => {
    const current = currentDraft();
    const snapshot = publishedSnapshot(
      demoRepresentative.pricing.map((plan) => ({ ...plan })),
    );
    const runtime = applyRepresentativeVersionSnapshot(current, {
      ...snapshot,
      groupActivation: "reply_or_mention",
    });

    expect(runtime.name).toBe("Published representative");
    expect(runtime.tagline).toBe("Published tagline");
    expect(runtime.publicMode).toBe(true);
    expect(runtime.groupActivation).toBe("reply_or_mention");
    expect(runtime.knowledgePack.identitySummary).toBe("Published knowledge");
    expect(runtime.pricing).toEqual(demoRepresentative.pricing);
    expect(runtime.handoffPrompt).toBe("Published handoff");
  });

  it("uses one strict public gate for page and APIs", () => {
    const available = {
      lifecycleState: "PUBLISHED",
      publicMode: true,
      activeVersionId: "version-1",
      webChannelStatuses: ["CONNECTED"],
    };
    expect(resolvePublicRepresentativeAvailability(available)).toBe("available");
    expect(resolvePublicRepresentativeAvailability({ ...available, lifecycleState: "PAUSED" })).toBe("paused");
    expect(resolvePublicRepresentativeAvailability({ ...available, publicMode: false })).toBe("private");
    expect(resolvePublicRepresentativeAvailability({ ...available, activeVersionId: null })).toBe("unpublished");
    expect(resolvePublicRepresentativeAvailability({ ...available, webChannelStatuses: ["DISCONNECTED"] })).toBe("web_disabled");
  });

  it("reads legacy pricing fields and uses a conservative group trigger for old versions", () => {
    const legacyPricing = demoRepresentative.pricing.map((plan) => ({
      type: plan.tier.toUpperCase(),
      name: plan.name,
      starsAmount: plan.stars,
      summary: plan.summary,
      includedReplies: plan.includedReplies,
      includesPriorityHandoff: plan.includesPriorityHandoff,
    }));
    const runtime = applyRepresentativeVersionSnapshot(
      currentDraft(),
      publishedSnapshot(legacyPricing),
    );

    expect(runtime.pricing).toEqual(demoRepresentative.pricing);
    expect(runtime.groupActivation).toBe("mention_only");
  });
});
