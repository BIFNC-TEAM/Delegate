import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMatrixRoomSecuritySnapshot: vi.fn(),
  isolateMatrixConversationRoom: vi.fn(),
  withActiveMatrixRepresentativeChannelFence: vi.fn(),
  withGenerationMessageProviderDeliveryFence: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  GenerationMemoryDeliveryBlockedError:
    class GenerationMemoryDeliveryBlockedError extends Error {
      readonly code = "generation_memory_delivery_source_revoked";
    },
  getMatrixRoomSecuritySnapshot: mocks.getMatrixRoomSecuritySnapshot,
  isolateMatrixConversationRoom: mocks.isolateMatrixConversationRoom,
  withActiveMatrixRepresentativeChannelFence:
    mocks.withActiveMatrixRepresentativeChannelFence,
  withGenerationMessageProviderDeliveryFence:
    mocks.withGenerationMessageProviderDeliveryFence,
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
      expectedEndpointLifecycleRevision: 7,
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
        expectedEndpointLifecycleRevision: 7,
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
      expectedEndpointLifecycleRevision: 7,
      deliveryId: "run-1",
      senderMode: "ai",
      generationRunId: "run-1",
      generationDelivery: {
        runId: "run-1",
        outboxId: "outbox-1",
        leaseAttempt: 2,
        outputMessageId: "output-1",
        deliveryAdmission: {
          attemptNumber: 2,
          leaseToken: "delivery-lease-2",
        },
      },
      text: "AI reply",
    });

    const [, request] = fetchMock.mock.calls[2] as [URL, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      msgtype: "m.text",
      body: "AI reply",
      "com.delegate.sender_mode": "ai",
      "com.delegate.generation_run_id": "run-1",
    });
    expect(
      mocks.withGenerationMessageProviderDeliveryFence,
    ).toHaveBeenCalledWith(
      expect.anything(),
      {
        conversationId,
        runId: "run-1",
        outboxId: "outbox-1",
        leaseAttempt: 2,
        outputMessageId: "output-1",
        deliveryAdmission: {
          attemptNumber: 2,
          leaseToken: "delivery-lease-2",
        },
      },
      expect.any(Function),
    );
  });

  it.each([
    {
      label: "network outcome",
      providerResult: () => Promise.reject(new Error("network timeout")),
    },
    {
      label: "accepted response without event id",
      providerResult: () => Promise.resolve(jsonResponse({})),
    },
  ])("marks an unknown Matrix $label as non-retryable", async ({ providerResult }) => {
    mockActiveRoom();
    const fetchMock = validatedRoomFetch().mockImplementationOnce(
      providerResult,
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMatrixRepresentativeMessage({
      config,
      conversationId,
      roomId,
      senderUserId,
      expectedEndpointLifecycleRevision: 7,
      deliveryId: "unknown-outcome",
      senderMode: "ai",
      text: "possibly delivered",
    })).rejects.toMatchObject({ code: "matrix_provider_outcome_unknown" });
  });

  it("does not call Matrix after the provider memory fence cancels delivery", async () => {
    mockActiveRoom();
    mocks.withGenerationMessageProviderDeliveryFence.mockResolvedValueOnce({
      executed: false,
      reason: "memory_delivery_source_revoked",
    });
    const fetchMock = validatedRoomFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMatrixRepresentativeMessage({
      config,
      conversationId,
      roomId,
      senderUserId,
      expectedEndpointLifecycleRevision: 7,
      deliveryId: "run-forgotten",
      senderMode: "ai",
      generationRunId: "run-forgotten",
      generationDelivery: {
        runId: "run-forgotten",
        outboxId: "outbox-forgotten",
        leaseAttempt: 3,
        outputMessageId: "output-forgotten",
        deliveryAdmission: {
          attemptNumber: 3,
          leaseToken: "delivery-lease-3",
        },
      },
      text: "must not leave",
    })).rejects.toMatchObject({
      code: "generation_memory_delivery_source_revoked",
    });

    // Only remote room validation ran; the provider send callback did not.
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      expectedEndpointLifecycleRevision: 7,
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
      expectedEndpointLifecycleRevision: 7,
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
      expectedEndpointLifecycleRevision: 7,
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
      expectedEndpointLifecycleRevision: 7,
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
      expectedEndpointLifecycleRevision: 7,
      deliveryId: "health-flip",
      senderMode: "ai",
      text: "must not leave",
    })).rejects.toThrow("became unavailable before outbound delivery");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not send an earlier activation's work after Matrix reconnects", async () => {
    mockActiveRoom();
    mocks.withActiveMatrixRepresentativeChannelFence.mockResolvedValueOnce({
      executed: false,
      reason: "matrix_channel_lifecycle_changed",
    });
    const fetchMock = validatedRoomFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMatrixRepresentativeMessage({
      config,
      conversationId,
      roomId,
      senderUserId,
      expectedEndpointLifecycleRevision: 7,
      deliveryId: "stale-activation",
      senderMode: "ai",
      text: "must not leave",
    })).rejects.toThrow(
      "Matrix channel activation changed before outbound delivery",
    );

    // Remote room validation completed, but the provider send callback stayed
    // behind the lifecycle fence and was never invoked.
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
      expectedEndpointLifecycleRevision: 7,
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
      expectedEndpointLifecycleRevision: 7,
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
      async (_input, operation: (tx: object) => Promise<unknown>) => ({
        executed: true,
        value: await operation({}),
      }),
    );
    mocks.withGenerationMessageProviderDeliveryFence.mockImplementation(
      async (_tx, _input, operation: () => Promise<unknown>) => ({
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
