import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const errorPage = readFileSync(
  new URL("../app/auth/error/page.tsx", import.meta.url),
  "utf8",
);

describe("Creator auth recovery page", () => {
  it("offers explicit self-service registration while preserving a sanitized return path", () => {
    expect(errorPage).toContain('"creator_registration_required"');
    expect(errorPage).toContain('buildCreatorAuthHref("register", returnTo)');
    expect(errorPage).toContain("免费注册 Creator · Sign up free");
    expect(errorPage).toContain("sanitizeCreatorReturnTo(params?.returnTo)");
    expect(errorPage).toContain('params.set("lang", locale)');
  });

  it("keeps invitation-only denial on the sign-in path", () => {
    expect(errorPage).toContain('"creator_access_required"');
    expect(errorPage).toContain('buildCreatorAuthHref("sign_in", returnTo)');
    expect(errorPage).toContain("此账号尚未开通 Creator 权限");
  });
});
