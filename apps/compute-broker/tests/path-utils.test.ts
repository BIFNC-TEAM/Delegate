import { describe, expect, it } from "vitest";

import { normalizeContainerPath } from "../src/path-utils";

describe("compute sandbox path boundaries", () => {
  it("accepts only the workspace and tmp directories or their descendants", () => {
    expect(normalizeContainerPath("notes/report.md")).toBe("/workspace/notes/report.md");
    expect(normalizeContainerPath("/workspace")).toBe("/workspace");
    expect(normalizeContainerPath("/workspace/notes/report.md")).toBe("/workspace/notes/report.md");
    expect(normalizeContainerPath("/tmp/result.txt")).toBe("/tmp/result.txt");
  });

  it("rejects sibling paths that merely share an allowed prefix", () => {
    expect(() => normalizeContainerPath("/workspace-private/secret.txt"))
      .toThrow("path_outside_allowed_workspace");
    expect(() => normalizeContainerPath("/tmp-backup/secret.txt"))
      .toThrow("path_outside_allowed_workspace");
  });
});
