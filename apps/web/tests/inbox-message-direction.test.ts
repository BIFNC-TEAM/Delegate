import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cssPath = fileURLToPath(new URL("../app/dashboard/dashboard-v2.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");
const inboxSource = readFileSync(
  fileURLToPath(new URL("../app/dashboard/dashboard-inbox.tsx", import.meta.url)),
  "utf8",
);

describe("owner inbox message direction", () => {
  it("places audience messages on the left and representative/operator replies on the right", () => {
    expect(css).toMatch(/article\.is-audience\s*\{\s*align-self:\s*flex-start/);
    expect(css).toMatch(
      /article\.is-representative,\s*\n\.inbox-message-timeline article\.is-operator\s*\{\s*align-self:\s*flex-end/,
    );
  });

  it("keeps system and tool events centered", () => {
    expect(css).toMatch(
      /article\.is-system,\s*\n\.inbox-message-timeline article\.is-tool\s*\{\s*align-self:\s*center/,
    );
  });

  it("renders visitor attachments with preview and download affordances", () => {
    expect(inboxSource).toContain("message.attachments.length");
    expect(inboxSource).toContain("inbox-message-attachments");
    expect(inboxSource).toContain('attachment.mimeType?.startsWith("image/")');
    expect(inboxSource).toContain("attachment.downloadUrl");
    expect(css).toContain(".inbox-message-attachments");
  });
});
