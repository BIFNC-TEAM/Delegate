import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/page.tsx"),
  "utf8",
);
const stylesSource = readFileSync(
  resolve(__dirname, "../../../packages/web-ui/styles/globals.css"),
  "utf8",
);

describe("public representative profile header", () => {
  it("keeps the utility bar global and the representative identity in the profile stage", () => {
    const topbarStart = pageSource.indexOf('<header className="marketing-topbar representative-topbar">');
    const topbarEnd = pageSource.indexOf("</header>", topbarStart);
    const topbarSource = pageSource.slice(topbarStart, topbarEnd);
    const stageStart = pageSource.indexOf('className="representative-profile-stage"');
    const stageEnd = pageSource.indexOf("</section>", stageStart);
    const stageSource = pageSource.slice(stageStart, stageEnd);

    expect(topbarSource).toContain("<strong>Delegate</strong>");
    expect(topbarSource).toContain("{t.publicRepresentative}");
    expect(topbarSource).not.toContain("{representative.name}");
    expect(stageSource).toContain("{representative.name}");
    expect(stageSource).not.toContain('className="chip-row"');
  });

  it("collapses the wordmark copy instead of truncating it on narrow screens", () => {
    expect(stylesSource).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\.representative-profile-page \.representative-topbar-identity,[\s\S]*?display: none;/,
    );
  });
});
