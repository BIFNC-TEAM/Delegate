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
  it("keeps only global brand and account controls in the utility bar", () => {
    const topbarStart = pageSource.indexOf('<header className="marketing-topbar representative-topbar">');
    const topbarEnd = pageSource.indexOf("</header>", topbarStart);
    const topbarSource = pageSource.slice(topbarStart, topbarEnd);

    expect(topbarSource).toContain("<strong>Delegate</strong>");
    expect(topbarSource).toContain("{t.publicRepresentative}");
    expect(topbarSource).not.toContain("{representative.name}");
    expect(topbarSource).not.toContain("<RepresentativeProfileRailLink");
    expect(topbarSource.match(/<LanguageSwitcher/g)).toHaveLength(2);
    expect(topbarSource.match(/className="representative-account-language"/g)).toHaveLength(2);
    expect(pageSource).not.toContain('className="representative-profile-stage"');
  });

  it("collapses the wordmark copy instead of truncating it on narrow screens", () => {
    expect(stylesSource).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\.representative-profile-page \.representative-topbar-identity \{[\s\S]*?display: none;/,
    );
  });

  it("keeps the account popover visible outside the compact utility bar", () => {
    expect(stylesSource).toMatch(
      /\.representative-shell\.representative-profile-page \.representative-topbar \{[\s\S]*?overflow: visible;/,
    );
  });
});
