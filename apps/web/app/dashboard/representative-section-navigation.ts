export type RepresentativeSection = "directory" | "operations" | "setup";

export type RepresentativeSetupSection =
  | "basics"
  | "compute"
  | "contract"
  | "knowledge"
  | "memory"
  | "pricing";

export function commitRepresentativeSectionNavigation(
  history: Pick<History, "pushState">,
  navigation: { href: string } | null,
): boolean {
  if (!navigation) {
    return false;
  }

  history.pushState(null, "", navigation.href);
  return true;
}

export function planRepresentativeSectionNavigation({
  activeSection,
  activeSetupSection,
  activeSlug,
  currentSearch,
  locale,
  pathname,
  representativeSlugs,
  section,
  setupSection,
}: {
  activeSection: RepresentativeSection;
  activeSetupSection: RepresentativeSetupSection;
  activeSlug: string;
  currentSearch: string;
  locale: string;
  pathname: string;
  representativeSlugs: string[];
  section: RepresentativeSection;
  setupSection?: RepresentativeSetupSection | undefined;
}): { href: string } | null {
  const nextSetupSection = setupSection ?? activeSetupSection;

  if (
    section === activeSection &&
    (section !== "setup" || nextSetupSection === activeSetupSection)
  ) {
    return null;
  }

  const params = new URLSearchParams(currentSearch);
  params.set("view", "representatives");
  params.set("lang", locale);
  params.set("repSection", section);

  if (representativeSlugs.includes(activeSlug)) {
    params.set("rep", activeSlug);
  }

  if (section === "setup") {
    params.set("setupSection", nextSetupSection);
  } else {
    params.delete("setupSection");
  }

  return { href: `${pathname}?${params.toString()}` };
}
