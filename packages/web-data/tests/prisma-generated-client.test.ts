import { IdentityLinkProvider, OwnerIdentityLinkProvider } from "@prisma/client";
import { describe, expect, it } from "vitest";

describe("generated Prisma client auth enums", () => {
  it("includes providers used by representative auth routes", () => {
    expect(IdentityLinkProvider.LOGTO).toBe("LOGTO");
    expect(OwnerIdentityLinkProvider.LOGTO).toBe("LOGTO");
  });
});
