import { describe, expect, it } from "vitest";
import {
  generateRepresentativeBasics,
  onboardingCreateSchema,
  onboardingDraftSchema,
  onboardingStepError,
  suggestedServices,
  type OnboardingDraft,
} from "@delegate/domain/representative-onboarding";

const draft: OnboardingDraft = {
  version: 1,
  requestId: "5f574d62-3911-44f3-a519-6643c0972961",
  step: 3,
  fields: ["产品"],
  customField: "",
  name: "产品顾问",
  services: "梳理产品需求",
  tone: 0,
  avatarUrl: "",
};
describe("representative onboarding", () => {
  it("permits incomplete progress, but never creates from incomplete answers", () => {
    const incomplete = { ...draft, fields: [], services: "" };
    expect(onboardingDraftSchema.safeParse(incomplete).success).toBe(true);
    expect(onboardingCreateSchema.safeParse(incomplete).success).toBe(false);
    expect(onboardingStepError(incomplete, 0)).toBeTruthy();
    expect(onboardingStepError(incomplete, 2)).toBeTruthy();
  });
  it("requires details for other and permits a custom direction alone", () => {
    expect(
      onboardingCreateSchema.safeParse({ ...draft, fields: ["其他"] }).success,
    ).toBe(false);
    expect(
      onboardingCreateSchema.safeParse({
        ...draft,
        fields: [],
        customField: "数据分析",
      }).success,
    ).toBe(true);
  });
  it("validates limits, enum values, and persisted draft versions", () => {
    for (const patch of [
      { name: "a".repeat(61) },
      { services: "a".repeat(501) },
      { customField: "a".repeat(81) },
      { fields: ["unknown"] },
      { tone: 5 },
      { version: 2 },
      { step: -1 },
    ])
      expect(
        onboardingDraftSchema.safeParse({ ...draft, ...patch }).success,
      ).toBe(false);
    expect(
      onboardingCreateSchema.safeParse({ ...draft, services: "😀".repeat(500) })
        .success,
    ).toBe(true);
  });
  it("uses actual owner identity without inventing services or changing scope with tone", () => {
    const generated = generateRepresentativeBasics(draft, "真实昵称");
    expect(generated.identitySummary).toBe("真实昵称主要从事产品相关工作。");
    expect(generated.tagline).toBe(draft.services);
    expect(generated.languages).toEqual(["zh", "en"]);
    expect(
      generateRepresentativeBasics({ ...draft, tone: 4 }, "真实昵称").tagline,
    ).toBe(draft.services);
  });
  it("deduplicates and bounds service chips", () => {
    const options = suggestedServices(["销售", "销售", "教育", "产品"]);
    expect(options.length).toBeLessThanOrEqual(6);
    expect(new Set(options).size).toBe(options.length);
  });
});
