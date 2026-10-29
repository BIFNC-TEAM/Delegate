export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { cleanupExpiredObsidianConnections } = await import("@delegate/web-data/obsidian-sync");
  const { cleanupExpiredNotionConnections } = await import("@delegate/web-data/notion");
  let running = false;
  const cleanup = () => {
    if (running) return;
    running = true;
    void Promise.all([cleanupExpiredObsidianConnections(), cleanupExpiredNotionConnections()])
      .catch(() => { console.warn("Import connection cleanup unavailable."); })
      .finally(() => { running = false; });
  };
  cleanup();
  setInterval(cleanup, 60_000).unref();
}
