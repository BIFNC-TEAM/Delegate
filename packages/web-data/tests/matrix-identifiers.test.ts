import { describe, expect, it } from "vitest";

import {
  matrixServerNameFromUserId,
  normalizeMatrixRoomId,
  normalizeMatrixServerName,
  normalizeMatrixUserId,
} from "../src/matrix-identifiers";

describe("Matrix identifiers", () => {
  it("preserves case-sensitive server names and explicit ports", () => {
    expect(normalizeMatrixUserId("@Alice:Matrix.Example:8448")).toBe(
      "@Alice:Matrix.Example:8448",
    );
    expect(
      matrixServerNameFromUserId("@Alice:Matrix.Example:8448"),
    ).toBe("Matrix.Example:8448");
    expect(normalizeMatrixRoomId("!Room:Matrix.Example:8448")).toBe(
      "!Room:Matrix.Example:8448",
    );
    expect(normalizeMatrixServerName(" Matrix.Example:8448 ")).toBe(
      "Matrix.Example:8448",
    );
    expect(normalizeMatrixUserId("@u:matrix.org")).not.toBe(
      normalizeMatrixUserId("@u:MATRIX.ORG"),
    );
  });

  it("supports bracketed IPv6 server names with an optional port", () => {
    expect(normalizeMatrixUserId("@Alice:[2001:db8::1]")).toBe(
      "@Alice:[2001:db8::1]",
    );
    expect(normalizeMatrixRoomId("!Room:[2001:DB8::1]:8448")).toBe(
      "!Room:[2001:DB8::1]:8448",
    );
    expect(
      matrixServerNameFromUserId("@Alice:[2001:DB8::1]:8448"),
    ).toBe("[2001:DB8::1]:8448");
  });

  it.each([
    "alice:example.org",
    "@:example.org",
    "@alice:",
    "@alice:bad host",
    "@alice:example.org:0",
    "@alice:example.org:70000",
    "@alice:2001:db8::1",
    "@alice:[2001:db8::1]:70000",
  ])("rejects invalid MXID %s", (value) => {
    expect(() => normalizeMatrixUserId(value)).toThrow("full MXID");
  });
});
