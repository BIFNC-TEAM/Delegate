async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl || !/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:15432\/delegate(?:\?|$)/u.test(databaseUrl)) {
    throw new Error("DATABASE_URL must target the isolated 127.0.0.1:15432 Delegate database.");
  }
  const conversationId = process.argv[2]?.trim();
  if (!conversationId) throw new Error("A test conversation id is required.");

  const { assignConversationOperator } = await import("../packages/web-data/src/index.ts");
  const result = await assignConversationOperator({
    representativeSlug: "lin-founder-rep",
    conversationId,
    operatorId: "agent-test-ui-operator",
    operatorName: "Agent Test UI Operator",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
