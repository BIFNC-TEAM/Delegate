export type PublicMemoryDisplayAck = {
  runId: string;
  outputMessageId: string;
};

export type MemoryDisplayAwareMessage = {
  citations?: readonly unknown[];
  displayAck?: PublicMemoryDisplayAck;
};

export function collectPendingMemoryDisplayAcks(
  messages: readonly MemoryDisplayAwareMessage[],
  acknowledgedKeys: ReadonlySet<string>,
) {
  const pending: PublicMemoryDisplayAck[] = [];
  const collected = new Set<string>();
  for (const message of messages) {
    if (!message.citations?.length || !message.displayAck) continue;
    const key = memoryDisplayAckKey(message.displayAck);
    if (acknowledgedKeys.has(key) || collected.has(key)) continue;
    collected.add(key);
    pending.push(message.displayAck);
  }
  return pending;
}

export function memoryDisplayAckKey(ack: PublicMemoryDisplayAck) {
  return `${ack.runId}:${ack.outputMessageId}`;
}

export async function sendPublicMemoryDisplayAck(
  representativeSlug: string,
  ack: PublicMemoryDisplayAck,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(
    `/reps/${encodeURIComponent(representativeSlug)}/chat/runs/${encodeURIComponent(ack.runId)}/display-ack`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outputMessageId: ack.outputMessageId }),
    },
  );
  if (!response.ok) {
    throw new Error(`Memory display acknowledgement failed (${response.status}).`);
  }
}
