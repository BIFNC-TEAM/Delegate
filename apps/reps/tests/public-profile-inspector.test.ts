import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const chatSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/representative-chat-panel.tsx"),
  "utf8",
);
const inspectorSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/representative-profile-inspector.tsx"),
  "utf8",
);
const pageSource = readFileSync(
  resolve(__dirname, "../app/reps/[slug]/page.tsx"),
  "utf8",
);

describe("public representative profile inspector", () => {
  it("keeps the conversation dominant while making the contextual rail dismissible", () => {
    expect(chatSource).toContain('aria-controls="representative-profile-rail"');
    expect(chatSource).toContain('className="representative-profile-rail-toggle"');
    expect(chatSource).toContain("setProfileRailVisibility(false)");
    expect(chatSource).toContain("delegate:representative-profile-rail:");
    expect(chatSource).toContain("REPRESENTATIVE_PROFILE_RAIL_OPEN_EVENT");
    expect(chatSource).toContain('document.body.style.overflow = "hidden"');
    expect(chatSource).toContain('const PROFILE_RAIL_COMPACT_QUERY = "(max-width: 1180px)"');
    expect(chatSource).toContain('compactViewport.addEventListener("change"');
    expect(chatSource).toContain("element.inert = true");
    expect(chatSource).toContain('event.key !== "Tab"');
    expect(chatSource).toContain('document.querySelector(".representative-profile-modal")');
    expect(chatSource).toContain('role={profileRailCompact ? "dialog" : undefined}');
    expect(chatSource).toContain('aria-modal={profileRailCompact ? true : undefined}');
    expect(chatSource).toContain("profileRailOpenerRef.current");
    expect(chatSource).toContain('className={`representative-profile-rail-backdrop');
    expect(chatSource).toContain("{props.profilePanel}");
  });

  it("uses real server-backed channel and order states without inventing availability", () => {
    expect(inspectorSource).toContain(
      'fetch(`/reps/${props.representativeSlug}/identity-bindings`',
    );
    expect(inspectorSource).toContain(
      'fetch(`/reps/${props.representativeSlug}/recharge?currency=CNY`',
    );
    expect(inspectorSource).toContain('setBindingState({ status: "unavailable" })');
    expect(inspectorSource).toContain('setRecentOrderState({ status: "unavailable" })');
    expect(inspectorSource).toContain("payload.orders[0] ?? null");
    expect(inspectorSource).not.toContain("order.id}");
    expect(inspectorSource).not.toContain("audienceIdentityId");
  });

  it("uses progressive disclosure for secondary profile information", () => {
    expect(inspectorSource).toContain('className="representative-profile-inspector"');
    expect(inspectorSource.match(/<details className="representative-inspector-section"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(inspectorSource).toContain('aria-haspopup="dialog"');
    expect(inspectorSource).toContain('aria-modal="true"');
    expect(inspectorSource).toContain('event.key === "Escape"');
    expect(inspectorSource).toContain('event.key !== "Tab"');
    expect(inspectorSource).toContain("modalTriggerRef.current?.focus()");
    expect(inspectorSource).toContain("REPRESENTATIVE_PROFILE_SECTION_OPEN_EVENT");
    expect(inspectorSource).toContain('activeModal === "bindings"');
    expect(inspectorSource).toContain('activeModal === "services"');
    expect(inspectorSource).toContain('openModal("privacy"');
  });

  it("passes only public profile, catalog, resource, and trust projections", () => {
    expect(pageSource).toContain("<RepresentativeProfileInspector");
    expect(pageSource).toContain("packagePreview={profilePackagePreview}");
    expect(pageSource).toContain("bindingManagement={audienceSession ? (");
    expect(pageSource).toContain("commerceManagement={hasPublicCommerce ? (");
    expect(pageSource).toContain("resources={profileResources}");
    expect(pageSource).toContain("trustItems={t.trustItems(runtime.governedContextEnabled)}");
    expect(pageSource).not.toContain("providerTransactionId");
  });
});
