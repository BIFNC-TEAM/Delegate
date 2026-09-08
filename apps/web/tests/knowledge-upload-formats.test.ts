import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const component = readFileSync(
  new URL("../app/dashboard/dashboard-knowledge-library.tsx", import.meta.url),
  "utf8",
);
const route = readFileSync(
  new URL("../app/api/dashboard/knowledge-assets/route.ts", import.meta.url),
  "utf8",
);

describe("knowledge upload format contract", () => {
  it("keeps browser selection, validation, kind mapping, and API filtering aligned", () => {
    for (const extension of [
      ".pdf",
      ".docx",
      ".pptx",
      ".xlsx",
      ".png",
      ".jpg",
      ".jpeg",
      ".txt",
      ".md",
      ".markdown",
    ]) {
      expect(component).toContain(extension);
    }
    for (const kind of ["pdf", "docx", "pptx", "xlsx", "image", "txt", "markdown"]) {
      expect(component).toContain(`["${kind}",`);
      expect(route).toContain(`"${kind}"`);
    }
    expect(component).toContain('extension === "png" || extension === "jpg" || extension === "jpeg" ? "image"');
  });
});
