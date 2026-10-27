import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startSiteSessionSync,
  type SiteSessionState,
} from "../app/site-session-client";

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});

function setup(fetcher = vi.fn<typeof fetch>()) {
  const browser = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  const states: SiteSessionState[] = [];
  const sync = startSiteSessionSync({
    dashboardBaseUrl: "http://localhost:3001",
    browser,
    document,
    fetcher,
    onChange: (state) => states.push(state),
  });
  disposers.push(sync.dispose);
  return { ...sync, browser, document, states, fetcher };
}
const account = { displayName: "Lin", email: "lin@example.com" };
const signedIn = () => Response.json({ authenticated: true, account });
const signedOut = () => Response.json({ authenticated: false });

describe("website session synchronization", () => {
  it("includes credentials and refreshes after login/logout in another tab", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(signedOut())
      .mockResolvedValueOnce(signedIn())
      .mockResolvedValueOnce(signedOut());
    const session = setup(fetcher);
    await vi.waitFor(() =>
      expect(session.states.at(-1)).toEqual({ status: "anonymous" }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://localhost:3001/api/auth/site-session"),
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
    session.browser.dispatchEvent(new Event("focus"));
    await vi.waitFor(() =>
      expect(session.states.at(-1)).toEqual({
        status: "authenticated",
        account,
      }),
    );
    session.browser.dispatchEvent(new Event("pageshow"));
    await vi.waitFor(() =>
      expect(session.states.at(-1)).toEqual({ status: "anonymous" }),
    );
  });

  it("rechecks visibility and coalesces simultaneous return events", async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue(signedIn());
    const session = setup(fetcher);
    session.browser.dispatchEvent(new Event("focus"));
    session.browser.dispatchEvent(new Event("pageshow"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    complete(signedOut());
    await vi.waitFor(() => expect(session.states).toHaveLength(1));
    session.document.visibilityState = "hidden";
    session.document.dispatchEvent(new Event("visibilitychange"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    session.document.visibilityState = "visible";
    session.document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() =>
      expect(session.states.at(-1)?.status).toBe("authenticated"),
    );
  });

  it.each([403, 500, 503])(
    "does not mistake HTTP %s for a signed-out session and can retry",
    async (status) => {
      const session = setup(
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(null, { status }))
          .mockResolvedValueOnce(signedIn()),
      );
      await vi.waitFor(() =>
        expect(session.states).toEqual([{ status: "unavailable" }]),
      );
      await session.refresh();
      expect(session.states.at(-1)).toEqual({
        status: "authenticated",
        account,
      });
    },
  );

  it("rejects malformed account data rather than crashing the username menu", async () => {
    const session = setup(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ authenticated: true, account: { email: 123 } }),
        ),
    );
    await vi.waitFor(() =>
      expect(session.states.at(-1)?.status).toBe("unavailable"),
    );
  });

  it("aborts a stalled request and makes retry available", async () => {
    vi.useFakeTimers();
    const session = setup(
      vi
        .fn<typeof fetch>()
        .mockImplementation(
          (_url, init) =>
            new Promise((_resolve, reject) =>
              init?.signal?.addEventListener("abort", () =>
                reject(new Error("aborted")),
              ),
            ),
        ),
    );
    await vi.advanceTimersByTimeAsync(8000);
    expect(session.states).toEqual([{ status: "unavailable" }]);
  });

  it("does not publish stale results or refetch after unmount", async () => {
    let complete!: (response: Response) => void;
    const session = setup(
      vi.fn<typeof fetch>().mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      ),
    );
    session.dispose();
    complete(signedIn());
    await Promise.resolve();
    await Promise.resolve();
    session.browser.dispatchEvent(new Event("focus"));
    session.document.dispatchEvent(new Event("visibilitychange"));
    expect(session.states).toEqual([]);
    expect(session.fetcher).toHaveBeenCalledTimes(1);
  });
});
