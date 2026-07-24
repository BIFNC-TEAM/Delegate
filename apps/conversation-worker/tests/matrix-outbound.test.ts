import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMatrixRepresentativeMessage } from "../src/matrix-outbound";

const config = {
  port: 4040,
  pollMs: 500,
  matrixHomeserverUrl: "https://matrix.example.org",
  matrixApplicationServiceToken: "matrix-application-service-token",
};

describe("Matrix outbound authorship", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("labels human Operator delivery without a generation-run claim", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ event_id: "$operator-event" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMatrixRepresentativeMessage({
      config,
      roomId: "!room:example.org",
      senderUserId: "@_delegate_rep_lin:example.org",
      deliveryId: "operator-message-1",
      senderMode: "human_operator",
      text: "Owner: I am taking over.",
    })).resolves.toBe("$operator-event");

    const [, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      msgtype: "m.text",
      body: "Owner: I am taking over.",
      "com.delegate.sender_mode": "human_operator",
    });
  });

  it("keeps AI generation provenance on representative replies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ event_id: "$ai-event" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await sendMatrixRepresentativeMessage({
      config,
      roomId: "!room:example.org",
      senderUserId: "@_delegate_rep_lin:example.org",
      deliveryId: "run-1",
      senderMode: "ai",
      generationRunId: "run-1",
      text: "AI reply",
    });

    const [, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      msgtype: "m.text",
      body: "AI reply",
      "com.delegate.sender_mode": "ai",
      "com.delegate.generation_run_id": "run-1",
    });
  });
});
