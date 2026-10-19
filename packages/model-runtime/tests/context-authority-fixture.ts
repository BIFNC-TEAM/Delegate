import { AgentContextAuthorizationError, type AgentContextAuthorization } from "@delegate/runtime";
/** Only synthetic fixtures; production uses the database-backed source guard. */
export function fixtureContextAuthority(runId: string): AgentContextAuthorization {
  const proof = { version: 1 as const, runId, revision: "f".repeat(64) };
  return { snapshot: () => proof, check: async (_boundary, expected) => {
    if (expected && (expected.runId !== runId || expected.revision !== proof.revision)) throw new AgentContextAuthorizationError();
  } };
}
