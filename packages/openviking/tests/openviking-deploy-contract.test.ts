import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(
  new URL("../../../deploy/openviking/Dockerfile", import.meta.url),
  "utf8",
);
const composeFile = readFileSync(
  new URL("../../../compose.yml", import.meta.url),
  "utf8",
);

describe("OpenViking governed-memory deployment contract", () => {
  it("pins the first stable batch-write release by immutable OCI digest", () => {
    expect(dockerfile).toContain(
      "FROM ghcr.io/volcengine/openviking:v0.4.12"
      + "@sha256:0d99361a0029ce5221fd11588d9f0f374c6e5f8f1eacbcf1d76de6a0f6cd82cb",
    );
    expect(dockerfile).not.toContain("ghcr.io/volcengine/openviking:v0.4.9");
    expect(composeFile).toContain("image: delegate-openviking:v0.4.12-compat");
    expect(composeFile).not.toContain("image: delegate-openviking:v0.4.9-compat");
  });

  it("retains the Apple Silicon cryptography compatibility override", () => {
    expect(dockerfile).toContain("OpenViking v0.4.12 still uses Python 3.13");
    expect(dockerfile).toContain("cryptography 49.0.0");
    expect(dockerfile).toContain("--target /app/.venv/lib/python3.13/site-packages");
    expect(dockerfile).toContain('"cryptography==46.0.5"');
  });
});
