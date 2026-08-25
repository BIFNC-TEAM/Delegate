import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const layouts = [
  ["public representative", new URL("../app/layout.tsx", import.meta.url)],
  ["marketing site", new URL("../../site/app/layout.tsx", import.meta.url)],
  ["owner dashboard", new URL("../../web/app/layout.tsx", import.meta.url)],
] as const;

describe("root layout hydration boundary", () => {
  it.each(layouts)(
    "%s tolerates browser-extension attributes on the root html element",
    (_name, url) => {
      const source = readFileSync(url, "utf8");
      const htmlTag = source.match(/<html[\s\S]*?>/u)?.[0];

      expect(htmlTag).toContain("suppressHydrationWarning");
      expect(source).not.toContain("data-immersive-translate-page-theme");
    },
  );
});
