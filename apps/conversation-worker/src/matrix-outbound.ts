import type { ConversationWorkerConfig } from "./config";

export async function sendMatrixRepresentativeMessage(input: {
  config: ConversationWorkerConfig;
  roomId: string;
  senderUserId: string;
  deliveryId: string;
  senderMode: "ai" | "human_operator";
  generationRunId?: string;
  text: string;
}) {
  if (!input.config.matrixHomeserverUrl || !input.config.matrixApplicationServiceToken) {
    throw new Error("Matrix outbound delivery is not configured.");
  }

  const transactionId = `delegate-${input.deliveryId}`;
  const url = new URL(
    `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
    input.config.matrixHomeserverUrl,
  );
  url.searchParams.set("user_id", input.senderUserId);

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${input.config.matrixApplicationServiceToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      msgtype: "m.text",
      body: input.text,
      "com.delegate.sender_mode": input.senderMode,
      ...(input.generationRunId
        ? { "com.delegate.generation_run_id": input.generationRunId }
        : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => ({}))) as { event_id?: string; error?: string };
  if (!response.ok || !payload.event_id) {
    throw new Error(payload.error || `Matrix delivery failed with HTTP ${response.status}.`);
  }
  return payload.event_id;
}
