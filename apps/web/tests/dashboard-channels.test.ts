import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const component = readFileSync(
  new URL("../app/dashboard/dashboard-channels.tsx", import.meta.url),
  "utf8",
);
const framework = readFileSync(
  new URL("../app/dashboard/dashboard-framework.tsx", import.meta.url),
  "utf8",
);
const listRoute = readFileSync(
  new URL("../app/api/dashboard/channels/route.ts", import.meta.url),
  "utf8",
);
const stateRoute = readFileSync(
  new URL(
    "../app/api/dashboard/channels/[bindingId]/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const healthRoute = readFileSync(
  new URL(
    "../app/api/dashboard/channels/[bindingId]/health/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const management = readFileSync(
  new URL(
    "../../../packages/web-data/src/channel-management.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("dashboard channels", () => {
  it("renders real channel data instead of the framework blueprint", () => {
    expect(framework).toContain('props.activeView === "channels"');
    expect(framework).toContain("<DashboardChannels");
    expect(framework).toContain('"channels", "audit"');
    expect(component).toContain("OwnerChannelManagementSnapshot");
    expect(component).toContain("/api/dashboard/channels");
    expect(component).toContain("Telegram · via Matrix");
    expect(component).toContain("channel.legacyStatus");
    expect(component).toContain("channel.recentIngress");
    expect(component).toContain("channel.recentEgress");
  });

  it("authenticates every endpoint and disables private response caching", () => {
    expect(listRoute).toContain("requireDashboardApiOwnerSession");
    expect(listRoute).toContain('"Cache-Control": "private, no-store"');
    expect(stateRoute).toContain("requireDashboardApiOwnerSession");
    expect(stateRoute).toContain("resolveChannelRequestMetadata");
    expect(stateRoute).toContain("desiredState");
    expect(stateRoute.indexOf("requireDashboardApiOwnerSession")).toBeLessThan(
      stateRoute.indexOf("request.json()"),
    );
    expect(healthRoute).toContain("requireDashboardApiOwnerSession");
    expect(healthRoute).toContain("resolveChannelRequestMetadata");
    expect(healthRoute).toContain(
      "configuration_and_recent_delivery_history",
    );
  });

  it("owner-scopes mutations and audits actor, before/after, and correlation metadata", () => {
    expect(management).toContain("representative: { ownerId }");
    expect(management).toContain('action: "CHANNEL_DESIRED_STATE_CHANGED"');
    expect(management).toContain('action: "CHANNEL_HEALTH_CHECKED"');
    expect(management).toContain("actorId");
    expect(management).toContain("requestId");
    expect(management).toContain("idempotencyKey");
    expect(management).toContain("before:");
    expect(management).toContain("after:");
  });
});
