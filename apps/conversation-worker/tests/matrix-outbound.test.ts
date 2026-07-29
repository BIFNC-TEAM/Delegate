import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMatrixRoomSecuritySnapshot: vi.fn(),
  isolateMatrixConversationRoom: vi.fn(),
  withActiveMatrixRepresentativeChannelFence: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  getMatrixRoomSecuritySnapshot: mocks.getMatrixRoomSecuritySnapshot,
  isolateMatrixConversationRoom: mocks.isolateMatrixConversationRoom,
  withActiveMatrixRepresentativeChannelFence:
    mocks.withActiveMatrixRepresentativeChannelFence,
}));

import { sendMatrixRepresentativeMessage } from "../src/matrix-outbound";

const config = {
  port: 4040,
  pollMs: 500,
  matrixHomeserverUrl: "https://matrix.example.org",
  matrixApplicationServiceToken: "matrix-application-service-token",
};

describe("Matrix outbound authorship", () => {
  const conversationId = "conversation-1";
  const roomId = "!room:example.org";
  const senderUserId = "@_delegate_rep_lin:example.org";
  const audienceUserId = "@alice:example.org";

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("labels human Operator delivery without a generation-run claim", async () => {
    mockActiveRoom();
    const fetchMock = successfulMatrixFetch("$operator-event");
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMatrixRepresentativeMessage({
      config,
      conversationId,
      roomId,
      senderUserId,
      deliveryId: "operator-message-1",
      senderMode: "human_operator",
      text: "Owner: I am taking over.",
    })).resolves.toBe("$operator-event");

    const [, request] = fetchMock.mock.calls[2] as [URL, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      msgtype: "m.text",
      body: "Owner: I am taking over.",
      "com.delegate.sender_mode": "human_operator",
    });
    expect(
      mocks.withActiveMatrixRepresentativeChannelFence,
    ).toHaveBeenCalledWith(
      {
        representativeId: "representative-1",
        representativeMatrixUserId: senderUserId,
        room: {
          roomId,
          conversationId,
          audienceMatrixUserId: audienceUserId,
          requireActiveAudienceProof: true,
        },
      },
      expect.any(Function),
    );
  });

  it("keeps AI generation provenance on representative replies", async () => {
    mockActiveRoom();
    const fetchMock = successfulMatrixFetch("$ai-event");
    vi.stubGlobal("fetch", fetchMock);

    await sendMatrixRepresentativeMessage({
      config,
      conversationId,
      roomId,
      senderUserId,
      deliveryId: "run-1",
      senderMode: "ai",
      generationRunId: "run-1",
      text: "AI reply",
    });

    const [, request] = fetchMock.mock.calls[2] as [URL, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      msgtype: "m.text",
      body: "AI reply",
      "com.delegate.sender_mode": "ai",
      "com.delegate.generation_run_id": "run-1",
    });
  });

  it("isolates a room whose authoritative joined members changed", async () => {
    mockActiveRoom();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      joined: {
        [senderUserId]: {},
        [audienceUserId]: {},
        "@mallory:example.org": {},
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMatrixRepresentativeMessage({
      config,
      conversationId,
      roomId,
      senderUserId,
      deliveryId: "unsafe-members",
      senderMode: "ai",
      text: "must not leave",
    })).rejects.toThrow("membership changed");

    expect(mocks.isolateMatrixConversationRoom).toHaveBeenCalledWith({
      roomId,
      reason: "matrix_remote_room_validation_failed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("isolates an encrypted room before sending", async () => {
    mockActiveRoom();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        joined: {
          [senderUserId]: {},
          [audienceUserId]: {},
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        algorithm: "m.megolm.v1.aes-sha2",
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMatrixRepresentativeMessage({
      config,
      conversationId,
      roomId,
      senderUserId,
      deliveryId: "unsafe-encryption",
      senderMode: "human_operator",
      text: "must not leave",
    })).rejects.toThrow("encryption was enabled");

    expect(mocks.isolateMatrixConversationRoom).toHaveBeenCalledWith({
      roomId,
      reason: "matrix_room_encrypted",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not send after the representative Matrix channel is disconnected", async () => {
    mockActiveRoom();
    mocks.getMatrixRoomSecuritySnapshot.mockResolvedValueOnce({
      securityState: "ACTIVE",
      audienceMatrixUserId: audienceUserId,
      representativeMatrixUserId: senderUserId,
      representativeChannelDesiredState: "DISCONNECTED",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMatrixRepresentativeMessage({
      config,
      conversationId,
      roomId,
      senderUserId,
      deliveryId: "disconnected-channel",
      senderMode: "ai",
      text: "must not leave",
    })).rejects.toThrow("not an active verified direct room");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send when disconnect wins after remote room validation", async () => {
    mockActiveRoom();
    mocks.withActiveMatrixRepresentativeChannelFence.mockResolvedValueOnce({
      executed: false,
      reason: "matrix_channel_not_active",
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        joined: {
          [senderUserId]: {},
          [audienceUserId]: {},
        },
      }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMatrixRepresentativeMessage({
      config,
      conversationId,
      roomId,
      senderUserId,
      deliveryId: "disconnect-race",
      senderMode: "ai",
      text: "must not leave",
    })).rejects.toThrow("became unavailable before outbound delivery");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not send when channel health flips unhealthy after remote room validation", async () => {
    mockActiveRoom();
    mocks.withActiveMatrixRepresentativeChannelFence.mockResolvedValueOnce({
      executed: false,
      reason: "matrix_channel_not_active",
    });
    const fetchMock = validatedRoomFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMatrixRepresentativeMessage({
      config,
      conversationId,
      roomId,
      senderUserId,
      deliveryId: "health-flip",
      senderMode: "ai",
      text: "must not leave",
    })).rejects.toThrow("became unavailable before outbound delivery");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not send when local isolation wins after remote room validation", async () => {
    mockActiveRoom();
    mocks.withActiveMatrixRepresentativeChannelFence.mockResolvedValueOnce({
      executed: false,
      reason: "matrix_room_not_active",
    });
    const fetchMock = validatedRoomFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMatrixRepresentativeMessage({
      config,
      conversationId,
      roomId,
      senderUserId,
      deliveryId: "isolation-race",
      senderMode: "human_operator",
      text: "must not leave",
    })).rejects.toThrow("room was isolated before outbound delivery");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not send a queued reply after the audience Matrix proof is revoked", async () => {
    mockActiveRoom();
    mocks.withActiveMatrixRepresentativeChannelFence.mockResolvedValueOnce({
      executed: false,
      reason: "matrix_audience_connection_not_verified",
    });
    const fetchMock = validatedRoomFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMatrixRepresentativeMessage({
      config,
      conversationId,
      roomId,
      senderUserId,
      deliveryId: "revoked-audience-proof",
      senderMode: "ai",
      text: "must not leave",
    })).rejects.toThrow(
      "Matrix audience connection is no longer verified",
    );

    // Only the joined-member and encryption checks ran. The fenced send
    // callback was never executed.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  function mockActiveRoom() {
    mocks.getMatrixRoomSecuritySnapshot.mockResolvedValue({
      conversationId,
      representativeId: "representative-1",
      securityState: "ACTIVE",
      audienceMatrixUserId: audienceUserId,
      representativeMatrixUserId: senderUserId,
      representativeChannelDesiredState: "ACTIVE",
    });
    mocks.isolateMatrixConversationRoom.mockResolvedValue(true);
    mocks.withActiveMatrixRepresentativeChannelFence.mockImplementation(
      async (_input, operation: () => Promise<unknown>) => ({
        executed: true,
        value: await operation(),
      }),
    );
  }

  function successfulMatrixFetch(eventId: string) {
    return validatedRoomFetch()
      .mockResolvedValueOnce(jsonResponse({ event_id: eventId }));
  }

  function validatedRoomFetch() {
    return vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        joined: {
          [senderUserId]: {},
          [audienceUserId]: {},
        },
      }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));
  }
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
