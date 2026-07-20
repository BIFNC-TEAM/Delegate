import { describe, expect, it } from "vitest";

import { getUsablePublicUrl } from "../app/reps/[slug]/public-materials";

describe("public representative materials", () => {
  it("does not expose upload locators as public links", () => {
    expect(getUsablePublicUrl("upload:training-faq.txt")).toBeNull();
  });

  it("allows safe relative and http links", () => {
    expect(getUsablePublicUrl("/reps/lin-founder-rep/deliverables/demo/download")).toBe(
      "/reps/lin-founder-rep/deliverables/demo/download",
    );
    expect(getUsablePublicUrl("https://delegate.example/materials/intro.pdf")).toBe(
      "https://delegate.example/materials/intro.pdf",
    );
  });

  it("filters placeholder example URLs", () => {
    expect(getUsablePublicUrl("https://example.com/materials/demo.pdf")).toBeNull();
  });
});
