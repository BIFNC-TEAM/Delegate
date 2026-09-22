import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
// Build the legacy term without introducing it back into searchable source.
const legacyTerm = "数字" + "代表";

describe("Chinese product terminology", () => {
  it("keeps the retired product label out of active code, defaults, tests and documentation", () => {
    const files = execFileSync("git", ["ls-files", "-z", "--", "apps", "packages", "prisma", "scripts", "deploy", "docs", "README.md"], { cwd: root, encoding: "utf8" })
      .split("\0").filter((path) => /\.(?:[cm]?[tj]sx?|json|md|html|css|ya?ml|sh|sql|prisma|toml|txt|svg|example)$/u.test(path));
    const violations = files.flatMap((path) => readFileSync(join(root, path), "utf8")
      .split("\n").flatMap((line, index) => line.includes(legacyTerm) ? [`${path}:${index + 1}`] : []));
    // Historical reports contain original model outputs and are intentionally
    // outside this check; renaming the product must not rewrite test evidence.
    expect(violations).toEqual([]);
  });
});
