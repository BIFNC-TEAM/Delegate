export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { cleanupExpiredObsidianConnections } = await import("@delegate/web-data/obsidian-sync");
  let running = false;
  const cleanup = () => {
    if (running) return;
    running = true;
    void cleanupExpiredObsidianConnections()
      .catch(() => { console.warn("Obsidian connection cleanup unavailable."); })
      .finally(() => { running = false; });
  };
  cleanup();
  setInterval(cleanup, 60_000).unref();
}
