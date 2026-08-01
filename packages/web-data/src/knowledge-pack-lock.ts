export type RepresentativeKnowledgePackLockClient = {
  $queryRaw?: <T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T>;
};

export async function acquireRepresentativeKnowledgePackLock(
  client: RepresentativeKnowledgePackLockClient,
  representativeId: string,
  options: {
    required?: boolean;
  } = {},
): Promise<void> {
  if (!client.$queryRaw) {
    if (options.required) {
      throw new Error("Representative KnowledgePack transaction advisory lock is unavailable.");
    }
    return;
  }

  const lockKey = `delegate:knowledge-pack:${representativeId}`;
  await client.$queryRaw`
    WITH lock_acquired AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    )
    SELECT 1::int AS acquired
    FROM lock_acquired
  `;
}
