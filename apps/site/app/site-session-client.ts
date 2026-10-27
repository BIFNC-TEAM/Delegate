export type SiteAccount = { displayName: string; email: string | null };
export type SiteSessionState =
  | { status: "loading" }
  | { status: "authenticated"; account: SiteAccount }
  | { status: "anonymous" }
  | { status: "unavailable" };

// Own the request and browser listeners together so restored pages and tab
// switches revalidate the session without leaving stale requests behind.
export function startSiteSessionSync(options: {
  dashboardBaseUrl: string;
  onChange: (state: SiteSessionState) => void;
  browser: Pick<Window, "addEventListener" | "removeEventListener">;
  document: Pick<
    Document,
    "addEventListener" | "removeEventListener" | "visibilityState"
  >;
  fetcher: typeof fetch;
}) {
  let disposed = false;
  let pending: AbortController | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const refresh = async () => {
    if (disposed || pending) return;
    const controller = new AbortController();
    pending = controller;
    timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await options.fetcher(
        new URL("/api/auth/site-session", options.dashboardBaseUrl),
        {
          cache: "no-store",
          credentials: "include",
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error("Session unavailable");
      const payload: unknown = await response.json();
      if (disposed || controller.signal.aborted) return;
      if (isAccountResponse(payload)) {
        options.onChange({ status: "authenticated", account: payload.account });
      } else if (
        payload &&
        typeof payload === "object" &&
        "authenticated" in payload &&
        payload.authenticated === false
      ) {
        options.onChange({ status: "anonymous" });
      } else {
        throw new Error("Invalid session response");
      }
    } catch {
      if (!disposed) options.onChange({ status: "unavailable" });
    } finally {
      clearTimeout(timeout);
      pending = null;
    }
  };
  const onVisible = () => {
    if (options.document.visibilityState === "visible") void refresh();
  };
  const onReturn = () => {
    void refresh();
  };
  options.browser.addEventListener("focus", onReturn);
  options.browser.addEventListener("pageshow", onReturn);
  options.document.addEventListener("visibilitychange", onVisible);
  void refresh();

  return {
    refresh,
    dispose() {
      disposed = true;
      pending?.abort();
      clearTimeout(timeout);
      options.browser.removeEventListener("focus", onReturn);
      options.browser.removeEventListener("pageshow", onReturn);
      options.document.removeEventListener("visibilitychange", onVisible);
    },
  };
}

function isAccountResponse(
  value: unknown,
): value is { authenticated: true; account: SiteAccount } {
  if (
    !value ||
    typeof value !== "object" ||
    !("authenticated" in value) ||
    value.authenticated !== true ||
    !("account" in value)
  )
    return false;
  const account = value.account;
  return (
    !!account &&
    typeof account === "object" &&
    "displayName" in account &&
    typeof account.displayName === "string" &&
    "email" in account &&
    (account.email === null || typeof account.email === "string")
  );
}
