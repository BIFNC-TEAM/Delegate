import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), store: vi.fn() }));
vi.mock("../app/api/dashboard/auth", () => ({
  requireDashboardApiOwnerSession: mocks.session,
  dashboardAuthErrorResponse: () => null,
}));
vi.mock("@delegate/web-data/owner-avatar-storage", () => ({
  storeOwnerAvatar: mocks.store,
  MAX_AVATAR_FILE_BYTES: 5 * 1024 * 1024,
  AvatarUploadError: class extends Error {},
}));
import { POST } from "../app/api/dashboard/representatives/avatar/route";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ ownerId: "owner-test" });
  mocks.store.mockResolvedValue({
    url: "https://dashboard.test/api/avatars/test",
  });
});
it("requires owner authentication", async () => {
  mocks.session.mockResolvedValue(null);
  expect(
    (await POST(new Request("http://test", { method: "POST", body: "x" })))
      .status,
  ).toBe(401);
  expect(mocks.store).not.toHaveBeenCalled();
});
it("limits actual bytes even when content-length is missing", async () => {
  expect(
    (
      await POST(
        new Request("http://test", {
          method: "POST",
          body: new Uint8Array(5 * 1024 * 1024 + 1),
        }),
      )
    ).status,
  ).toBe(413);
  expect(mocks.store).not.toHaveBeenCalled();
});
it("stores under the authenticated owner without altering the account profile", async () => {
  const result = await POST(
    new Request("http://test", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    }),
  );
  expect(result.status).toBe(200);
  expect(mocks.store).toHaveBeenCalledWith(
    "owner-test",
    Buffer.from([1, 2, 3]),
  );
  expect(result.headers.get("cache-control")).toContain("no-store");
  expect(await result.json()).toEqual({
    url: "https://dashboard.test/api/avatars/test",
  });
});
