import { describe, expect, it } from "vitest";

import {
  commitRepresentativeSectionNavigation,
  planRepresentativeSectionNavigation,
} from "../app/dashboard/representative-section-navigation";

const baseNavigation = {
  activeSection: "operations" as const,
  activeSetupSection: "basics" as const,
  activeSlug: "sktone",
  currentSearch: "view=representatives&rep=sktone&lang=zh&repSection=operations",
  locale: "zh",
  pathname: "/dashboard",
  representativeSlugs: ["sktone", "second-rep"],
};

describe("representative section navigation", () => {
  it("does nothing when the active section is clicked again", () => {
    expect(
      planRepresentativeSectionNavigation({
        ...baseNavigation,
        section: "operations",
      }),
    ).toBeNull();
  });

  it("plans an in-page setup transition while preserving dashboard context", () => {
    const navigation = planRepresentativeSectionNavigation({
      ...baseNavigation,
      section: "setup",
      setupSection: "compute",
    });
    const pushes: string[] = [];
    const changed = commitRepresentativeSectionNavigation(
      {
        pushState: (_data, _unused, url) => {
          pushes.push(String(url));
        },
      },
      navigation,
    );

    expect(navigation).toEqual({
      href: "/dashboard?view=representatives&rep=sktone&lang=zh&repSection=setup&setupSection=compute",
    });
    expect(changed).toBe(true);
    expect(pushes).toEqual([
      "/dashboard?view=representatives&rep=sktone&lang=zh&repSection=setup&setupSection=compute",
    ]);
  });

  it("does nothing when the active setup subsection is selected again", () => {
    const navigation = planRepresentativeSectionNavigation({
      ...baseNavigation,
      activeSection: "setup",
      activeSetupSection: "knowledge",
      currentSearch:
        "view=representatives&rep=sktone&lang=zh&repSection=setup&setupSection=knowledge",
      section: "setup",
      setupSection: "knowledge",
    });
    const pushes: string[] = [];

    expect(navigation).toBeNull();
    expect(
      commitRepresentativeSectionNavigation(
        {
          pushState: (_data, _unused, url) => {
            pushes.push(String(url));
          },
        },
        navigation,
      ),
    ).toBe(false);
    expect(pushes).toEqual([]);
  });
});
