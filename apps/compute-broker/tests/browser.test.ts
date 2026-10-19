import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";

import {
  buildPlaywrightBrowseCommand,
  parsePlaywrightBrowseArtifactPayload,
} from "../src/browser";

describe("buildPlaywrightBrowseCommand", () => {
  it.each([
    { name: "sections and table columns", body: "Related list\nDelayed values\n\nCurrent item\nName\tValue\tChange\nExample\t12.30\t-1.20%", expected: "Related list\nDelayed values\n\nCurrent item\nName\tValue\tChange\nExample\t12.30\t-1.20%" },
    { name: "line endings and redundant spaces", body: "  Heading  \r\n  Value:   12.30 \r\n\r\n\r\n Name\tRate \n", expected: "Heading\nValue: 12.30\n\nName\tRate" },
    { name: "existing bounded snapshot", body: "Label\n" + "x".repeat(9000), expected: ("Label\n" + "x".repeat(9000)).slice(0, 8000) },
  ])("preserves visible-text structure in the executed browser recipe: $name", async ({ body, expected }) => {
    const outputs: string[] = []; const errors = vi.fn(); const exit = vi.fn();
    const page = { goto: async () => ({ status: () => 200 }), waitForLoadState: async () => {}, waitForTimeout: async () => {},
      title: async () => "Page", url: () => "https://example.invalid", content: async () => "<body></body>",
      evaluate: async () => body,
      locator: () => ({ innerText: async () => body, evaluateAll: async () => [] }), screenshot: async () => Buffer.from("screenshot") };
    const context = { pages: () => [page], close: async () => {} };
    const command = buildPlaywrightBrowseCommand({ url: "https://example.invalid", playwrightVersion: "1.58.2", anonymous: true });
    const quoted = command.slice(command.indexOf("\nnode -e ") + "\nnode -e ".length);
    const script = quoted.slice(1, -1).replace(/'"'"'/g, "'").replace("void (async", "(async");
    await runInNewContext(script, { Buffer, require: (name: string) => name === "playwright" ? { chromium: { launch: async () => ({ newContext: async () => context, close: async () => {} }) } } : { promises: {} },
      process: { env: {}, exit }, console: { log: (value: string) => outputs.push(value), error: errors } });
    expect(errors).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled(); expect(outputs).toHaveLength(1);
    const result = parsePlaywrightBrowseArtifactPayload(outputs[0]!);
    expect(result?.textSnippet).toBe(expected); expect(result?.httpStatus).toBe(200); expect(result?.finalUrl).toBe("https://example.invalid");
  });
  it("runs each anonymous recipe in a fresh context without loading the retained profile", async () => {
    const contexts: object[] = []; const outputs: string[] = [];
    let failNavigation = false;
    const persistent = vi.fn(() => { throw new Error("retained_profile_must_not_load"); });
    const mkdir = vi.fn(); const close = vi.fn(async () => undefined);
    const browser = { newContext: vi.fn(async () => {
      const cookies: string[] = []; contexts.push(cookies);
      const page = { goto: async () => { if (failNavigation) throw new Error("synthetic_navigation_failure"); return { status: () => 200 }; }, waitForLoadState: async () => {}, waitForTimeout: async () => {},
        title: async () => "Synthetic", url: () => "https://example.invalid", content: async () => "<body>Public</body>",
        evaluate: async () => cookies.length ? "SYNTHETIC_OLD_COOKIE" : "PUBLIC",
        locator: () => ({ innerText: async () => cookies.length ? "SYNTHETIC_OLD_COOKIE" : "PUBLIC", evaluateAll: async () => [] }),
        screenshot: async () => Buffer.from("synthetic") };
      return { pages: () => [], newPage: async () => page, close };
    }), close };
    const command = buildPlaywrightBrowseCommand({ url: "https://example.invalid", playwrightVersion: "1.58.2", anonymous: true });
    const quoted = command.slice(command.indexOf("\nnode -e ") + "\nnode -e ".length);
    const script = quoted.slice(1, -1).replace(/'"'"'/g, "'").replace("void (async", "(async");
    const errors = vi.fn(); const exit = vi.fn();
    for (let n = 0; n < 2; n++) await runInNewContext(script, { Buffer, require: (name: string) => name === "playwright" ? { chromium: { launch: async () => browser, launchPersistentContext: persistent } } : { promises: { mkdir } },
      process: { env: { DELEGATE_SESSION_ROOT: "/synthetic-private-profile" }, exit }, console: { log: (value: string) => outputs.push(value), error: errors } });
    expect(errors).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled(); expect(persistent).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(2); expect(contexts[0]).not.toBe(contexts[1]); expect(outputs).toHaveLength(2);
    expect(outputs.map(text => JSON.parse(text).textSnippet)).toEqual(["PUBLIC", "PUBLIC"]); expect(close).toHaveBeenCalledTimes(4);
    failNavigation = true;
    await runInNewContext(script, { Buffer, require: (name: string) => name === "playwright" ? { chromium: { launch: async () => browser } } : { promises: { mkdir } },
      process: { env: {}, exit }, console: { log: (value: string) => outputs.push(value), error: errors } });
    expect(close).toHaveBeenCalledTimes(6); expect(outputs).toHaveLength(2); expect(exit).toHaveBeenCalledWith(1);
  });
  it("builds a Playwright-backed browser command", () => {
    const command = buildPlaywrightBrowseCommand({
      url: "https://example.com",
      playwrightVersion: "1.58.2",
    });

    expect(command).toContain("npm install --silent --no-save playwright@1.58.2");
    expect(command).toContain("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1");
    expect(command).toContain('require(\'"\'"\'playwright\'"\'"\')');
    expect(command).toContain("launchPersistentContext");
    expect(command).toContain("browser-profile");
    expect(command).toContain("DELEGATE_SESSION_ROOT");
    expect(command).toContain("page.goto");
    expect(command).toContain("navigationResponse?.status()");
    expect(command).toContain("new Map(nodes.filter");
    expect(command).toContain("slice(0, 60)");
    expect(command).toContain("https://example.com");
    expect(command).toContain("page.screenshot");
    expect(command).toContain("type: '\"'\"'jpeg'\"'\"'");
    expect(command).toContain("screenshotBase64");
    expect(command).toContain("tencent-all-in-one");
    expect(command).toContain("npm root -g");
    expect(command).toContain("command -v chromium");
    expect(command).toContain("executablePath: process.env.DELEGATE_CHROMIUM_EXECUTABLE");
  });

  it("parses structured browser output", () => {
    const payload = parsePlaywrightBrowseArtifactPayload(
      JSON.stringify({
        transportKind: "playwright",
        profilePath: "/delegate-session/browser-profile",
        title: "Example Domain",
        finalUrl: "https://example.com/",
        textSnippet: "Example Domain This domain is for use in illustrative examples.",
        contentSnippet: "<html><body>Example Domain</body></html>",
        httpStatus: 200, observedAt: "2026-09-24T00:00:00.000Z",
        links: [{ text: "More information", href: "https://www.iana.org/domains/example" }],
        screenshotBase64: "cG5n",
        screenshotMimeType: "image/jpeg",
      }),
    );

    expect(payload).toEqual({
      transportKind: "playwright",
      profilePath: "/delegate-session/browser-profile",
      title: "Example Domain",
      finalUrl: "https://example.com/",
      textSnippet: "Example Domain This domain is for use in illustrative examples.",
      contentSnippet: "<html><body>Example Domain</body></html>",
      httpStatus: 200, observedAt: "2026-09-24T00:00:00.000Z",
      links: [{ text: "More information", href: "https://www.iana.org/domains/example" }],
      screenshotBase64: "cG5n",
      screenshotMimeType: "image/jpeg",
    });
  });

  it("returns null for malformed browser output", () => {
    expect(parsePlaywrightBrowseArtifactPayload("not-json")).toBeNull();
  });
});
