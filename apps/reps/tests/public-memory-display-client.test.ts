import { describe, expect, it, vi } from "vitest";

import {
  collectPendingMemoryDisplayAcks,
  memoryDisplayAckKey,
  sendPublicMemoryDisplayAck,
} from "../app/reps/[slug]/memory-display-client";

describe("public memory display client", () => {
  it("only acknowledges outputs whose cited context was rendered", () => {
    const acknowledged = new Set([
      memoryDisplayAckKey({
        runId: "run_already",
        outputMessageId: "message_already",
      }),
    ]);

    expect(collectPendingMemoryDisplayAcks([
      {
        citations: [{ title: "本人历史信息" }],
        displayAck: { runId: "run_1", outputMessageId: "message_1" },
      },
      {
        citations: [],
        displayAck: { runId: "run_without_visible_citation", outputMessageId: "message_2" },
      },
      {
        citations: [{ title: "Public FAQ" }],
      },
      {
        citations: [{ title: "Duplicate" }],
        displayAck: { runId: "run_1", outputMessageId: "message_1" },
      },
      {
        citations: [{ title: "Already acknowledged" }],
        displayAck: { runId: "run_already", outputMessageId: "message_already" },
      },
    ], acknowledged)).toEqual([
      { runId: "run_1", outputMessageId: "message_1" },
    ]);
  });

  it("sends an output-scoped acknowledgement without client-selected item ids", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await expect(sendPublicMemoryDisplayAck(
      "lin founder",
      { runId: "run/1", outputMessageId: "message_1" },
      fetcher as unknown as typeof fetch,
    )).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledWith(
      "/reps/lin%20founder/chat/runs/run%2F1/display-ack",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outputMessageId: "message_1" }),
      },
    );
    expect(fetcher.mock.calls[0]![1]!.body).not.toContain("memoryUseItemId");
  });

  it("keeps a failed acknowledgement retryable", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 409 });

    await expect(sendPublicMemoryDisplayAck(
      "delegate",
      { runId: "run_1", outputMessageId: "message_1" },
      fetcher as unknown as typeof fetch,
    )).rejects.toThrow("Memory display acknowledgement failed (409)");
  });
});
