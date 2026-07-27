import { describe, expect, it } from "vitest";

import { GET } from "../app/health/route";

describe("dashboard liveness route", () => {
  it("returns a constant, non-cacheable response without authentication", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
