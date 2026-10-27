export const PRODUCT_SCOPE = {
  origin: "http://127.0.0.1:13002", slug: "qa-agent-v2-product10-20261023",
  ownerId: "qa_agent_v2_product10_20261023", marker: "PRODUCT10_FIXTURE_V1",
};
export const PRODUCT_LIMITS = {
  requestMs: 150_000, responseBytes: 2_000_000, minTurnGapMs: 2500,
  admissionRetries: 2, maxRetryWaitMs: 35_000, judgeCalls: 96, judgeTokens: 400_000,
}; // Initial bounded test defaults, not performance acceptance criteria.
export function validateProductEnvironment(env: NodeJS.ProcessEnv) {
  const url = new URL(env.AGENT_TEST_DATABASE_URL ?? "postgresql://invalid");
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== "127.0.0.1" || url.port !== "15432" || url.pathname !== "/delegate" || url.search || url.hash) throw Error("isolated_database_required");
  if (env.DATABASE_URL && env.DATABASE_URL !== env.AGENT_TEST_DATABASE_URL) throw Error("database_environment_conflict");
  for (const name of ["OPENVIKING_BASE_URL", "OPENVIKING_INTERNAL_BASE_URL"]) {
    const endpoint = new URL(env[name] ?? "http://invalid");
    if (endpoint.origin !== "http://127.0.0.1:11933" || endpoint.username || endpoint.password || endpoint.pathname !== "/") throw Error("isolated_retrieval_required");
  }
  if (new URL(env.COMPUTE_BROKER_URL ?? "http://invalid").origin !== "http://127.0.0.1:14010") throw Error("isolated_broker_required");
  return url.toString();
}
export function assertNoCloud(authority: { compute: { capabilityModes: Record<string, string> } }) {
  for (const kind of ["exec", "write", "browser", "process", "read"]) {
    if (authority.compute.capabilityModes[kind] !== "deny") throw Error("cloud_capability_not_denied");
  }
}
