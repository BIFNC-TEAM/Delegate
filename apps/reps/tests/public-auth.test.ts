import { describe, expect, it } from "vitest";

import {
  buildPublicAudienceLoginHref,
  buildPublicAudienceLogoutHref,
  buildPublicAudienceReturnTo,
  sanitizePublicAudienceReturnTo,
} from "../app/reps/[slug]/public-auth";

describe("public representative auth links", () => {
  it("builds login and logout links with localized representative return paths", () => {
    expect(buildPublicAudienceReturnTo("lin-founder-rep", "zh")).toBe(
      "/reps/lin-founder-rep?lang=zh#chat",
    );
    expect(buildPublicAudienceLoginHref("lin-founder-rep", "zh")).toBe(
      "/reps/lin-founder-rep/auth/login?returnTo=%2Freps%2Flin-founder-rep%3Flang%3Dzh%23chat",
    );
    expect(buildPublicAudienceLogoutHref("lin-founder-rep", "en")).toBe(
      "/reps/lin-founder-rep/auth/logout?returnTo=%2Freps%2Flin-founder-rep%3Flang%3Den",
    );
  });

  it("keeps representative auth redirects scoped to the current public page", () => {
    expect(
      sanitizePublicAudienceReturnTo("/reps/lin-founder-rep?lang=zh#chat", "lin-founder-rep"),
    ).toBe("/reps/lin-founder-rep?lang=zh#chat");
    expect(sanitizePublicAudienceReturnTo("/reps/other-rep", "lin-founder-rep")).toBe(
      "/reps/lin-founder-rep#chat",
    );
    expect(sanitizePublicAudienceReturnTo("https://evil.example.com", "lin-founder-rep")).toBe(
      "/reps/lin-founder-rep#chat",
    );
  });
});
