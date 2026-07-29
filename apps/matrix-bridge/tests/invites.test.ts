import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockActivateVerifiedMatrixDirectConversation,
  mockCheckMatrixRuntimePersistenceReadiness,
  mockClearMatrixRoomRemoteValidationFailures,
  mockGetMatrixRoomSecuritySnapshot,
  mockGetMatrixVirtualUserBinding,
  mockIngestMatrixApplicationServiceTransaction,
  mockIsolateMatrixConversationRoom,
  mockRecordMatrixRoomRemoteValidationFailure,
  mockRecordMatrixRuntimeHealth,
  mockWithActiveMatrixRepresentativeChannelFence,
} = vi.hoisted(() => {
  process.env.MATRIX_AS_HS_TOKEN = "homeserver-token-that-is-long-enough";
  process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.org";
  process.env.MATRIX_AS_TOKEN = "application-service-token";
  process.env.MATRIX_SERVER_NAME = "example.org";
  return {
    mockActivateVerifiedMatrixDirectConversation: vi.fn(),
    mockCheckMatrixRuntimePersistenceReadiness: vi.fn(),
    mockClearMatrixRoomRemoteValidationFailures: vi.fn(),
    mockGetMatrixRoomSecuritySnapshot: vi.fn(),
    mockGetMatrixVirtualUserBinding: vi.fn(),
    mockIngestMatrixApplicationServiceTransaction: vi.fn(),
    mockIsolateMatrixConversationRoom: vi.fn(),
    mockRecordMatrixRoomRemoteValidationFailure: vi.fn(),
    mockRecordMatrixRuntimeHealth: vi.fn(),
    mockWithActiveMatrixRepresentativeChannelFence: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  activateVerifiedMatrixDirectConversation:
    mockActivateVerifiedMatrixDirectConversation,
  checkMatrixRuntimePersistenceReadiness:
    mockCheckMatrixRuntimePersistenceReadiness,
  clearMatrixRoomRemoteValidationFailures:
    mockClearMatrixRoomRemoteValidationFailures,
  getMatrixRoomSecuritySnapshot: mockGetMatrixRoomSecuritySnapshot,
  getMatrixVirtualUserBinding: mockGetMatrixVirtualUserBinding,
  ingestMatrixApplicationServiceTransaction:
    mockIngestMatrixApplicationServiceTransaction,
  isValidMatrixServerName: (value: string) => Boolean(value.trim()),
  isolateMatrixConversationRoom: mockIsolateMatrixConversationRoom,
  matrixServerNameFromUserId: (value: string) =>
    value.slice(value.indexOf(":", 1) + 1),
  normalizeMatrixUserId: (value: string) => {
    const normalized = value.trim();
    if (!/^@[^:\\s]+:.+$/.test(normalized)) {
      throw new Error("Matrix user id must be a full MXID.");
    }
    return normalized;
  },
  recordMatrixRoomRemoteValidationFailure:
    mockRecordMatrixRoomRemoteValidationFailure,
  recordMatrixRuntimeHealth: mockRecordMatrixRuntimeHealth,
  withActiveMatrixRepresentativeChannelFence:
    mockWithActiveMatrixRepresentativeChannelFence,
}));

import {
  checkMatrixBridgeReadiness,
  joinManagedMatrixInvites,
  processMatrixApplicationServiceTransaction,
  validateActiveMatrixRoomsBeforeIngest,
} from "../src/index";

const roomId = "!room:example.org";
const audienceMatrixUserId = "@alice:example.org";
const representativeMatrixUserId = "@_delegate_rep:example.org";

describe("managed Matrix invite joining", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetMatrixVirtualUserBinding.mockResolvedValue({
      matrixUserId: representativeMatrixUserId,
      representativeId: "representative-1",
      endpointAssignmentRevision: 1,
    });
    mockIsolateMatrixConversationRoom.mockResolvedValue(true);
    mockClearMatrixRoomRemoteValidationFailures.mockResolvedValue(false);
    mockRecordMatrixRoomRemoteValidationFailure.mockImplementation(
      async (input: { retryable: boolean }) => (
        input.retryable
          ? { status: "retry_scheduled", attemptCount: 1 }
          : { status: "isolated", attemptCount: 1 }
      ),
    );
    mockRecordMatrixRuntimeHealth.mockResolvedValue(true);
    mockWithActiveMatrixRepresentativeChannelFence.mockImplementation(
      async (_input, operation: () => Promise<unknown>) => ({
        executed: true,
        value: await operation(),
      }),
    );
    vi.stubGlobal("fetch", vi.fn());
  });

  it("does not register or join when disconnect wins the delivery fence", async () => {
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue(
      securitySnapshot("PENDING_REMOTE_VALIDATION"),
    );
    mockWithActiveMatrixRepresentativeChannelFence.mockResolvedValueOnce({
      executed: false,
      reason: "matrix_channel_not_active",
    });

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([]);

    expect(fetch).not.toHaveBeenCalled();
    expect(mockActivateVerifiedMatrixDirectConversation).not.toHaveBeenCalled();
  });

  it("does not validate or join an orphaned room assignment", async () => {
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue({
      ...securitySnapshot("PENDING_REMOTE_VALIDATION"),
      currentRepresentativeAssignmentRevision: null,
    });

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([]);

    expect(mockIsolateMatrixConversationRoom).toHaveBeenCalledWith({
      roomId,
      reason: "matrix_remote_room_validation_failed",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mockRecordMatrixRuntimeHealth).not.toHaveBeenCalled();
  });

  it("does not register or join a non-representative virtual user", async () => {
    mockGetMatrixVirtualUserBinding.mockResolvedValue({
      matrixUserId: representativeMatrixUserId,
      representativeId: null,
    });
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue(
      securitySnapshot("PENDING_REMOTE_VALIDATION"),
    );

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([]);

    expect(mockGetMatrixRoomSecuritySnapshot).not.toHaveBeenCalled();
    expect(mockWithActiveMatrixRepresentativeChannelFence).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "ACTIVE",
    "ISOLATED",
  ] as const)("treats a %s transaction replay as an idempotent no-op", async (
    securityState,
  ) => {
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue(
      securitySnapshot(securityState),
    );

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([]);

    expect(fetch).not.toHaveBeenCalled();
    expect(mockActivateVerifiedMatrixDirectConversation).not.toHaveBeenCalled();
    expect(mockIsolateMatrixConversationRoom).not.toHaveBeenCalled();
  });

  it("retries a failed join while the binding remains PENDING", async () => {
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue(
      securitySnapshot("PENDING_REMOTE_VALIDATION"),
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ user_id: representativeMatrixUserId }))
      .mockResolvedValueOnce(new Response("", { status: 502 }));

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([
      `${roomId}:${representativeMatrixUserId}:502`,
    ]);
    expect(mockActivateVerifiedMatrixDirectConversation).not.toHaveBeenCalled();
    expect(mockIsolateMatrixConversationRoom).not.toHaveBeenCalled();
    expect(mockRecordMatrixRuntimeHealth).toHaveBeenCalledWith({
      matrixUserId: representativeMatrixUserId,
      status: "DEGRADED",
      errorCode: "matrix_join_502",
      expectedAssignmentRevision: 1,
    });

    vi.mocked(fetch).mockReset();
    mockRecordMatrixRuntimeHealth.mockClear();
    vi.mocked(fetch)
      .mockResolvedValueOnce(matrixUserInUseResponse())
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        joined: {
          [audienceMatrixUserId]: {},
          [representativeMatrixUserId]: {},
        },
      }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    mockActivateVerifiedMatrixDirectConversation.mockResolvedValue(true);

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([]);
    expect(mockActivateVerifiedMatrixDirectConversation).toHaveBeenCalledTimes(1);
    expect(mockIsolateMatrixConversationRoom).not.toHaveBeenCalled();
    expect(mockRecordMatrixRuntimeHealth).toHaveBeenCalledWith({
      matrixUserId: representativeMatrixUserId,
      status: "HEALTHY",
      expectedAssignmentRevision: 1,
    });
    expect(
      mockWithActiveMatrixRepresentativeChannelFence,
    ).toHaveBeenLastCalledWith({
      representativeId: "representative-1",
      representativeMatrixUserId,
      room: {
        roomId,
        conversationId: "conversation-1",
        audienceMatrixUserId,
        expectedSecurityState: "PENDING_REMOTE_VALIDATION",
      },
    }, expect.any(Function));
  });

  it.each([400, 401, 403, 404, 409, 422])(
    "terminally isolates a deterministic join %s response",
    async (status) => {
      mockGetMatrixRoomSecuritySnapshot.mockResolvedValue(
        securitySnapshot("PENDING_REMOTE_VALIDATION"),
      );
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({
          user_id: representativeMatrixUserId,
        }))
        .mockResolvedValueOnce(new Response("", { status }));

      await expect(
        joinManagedMatrixInvites([directInviteEvent()]),
      ).resolves.toEqual([]);

      expect(mockRecordMatrixRoomRemoteValidationFailure).toHaveBeenCalledWith({
        roomId,
        errorCode: `matrix_join_${status}`,
        retryable: false,
        expectedSecurityState: "PENDING_REMOTE_VALIDATION",
        eventId: "$invite-1",
      });
      expect(mockActivateVerifiedMatrixDirectConversation).not.toHaveBeenCalled();
    },
  );

  it("retries a rate-limited join", async () => {
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue(
      securitySnapshot("PENDING_REMOTE_VALIDATION"),
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        user_id: representativeMatrixUserId,
      }))
      .mockResolvedValueOnce(new Response("", { status: 429 }));

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([
      `${roomId}:${representativeMatrixUserId}:429`,
    ]);
    expect(mockRecordMatrixRoomRemoteValidationFailure).toHaveBeenCalledWith({
      roomId,
      errorCode: "matrix_join_429",
      retryable: true,
      expectedSecurityState: "PENDING_REMOTE_VALIDATION",
      eventId: "$invite-1",
    });
  });

  it("retries a timed-out join", async () => {
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue(
      securitySnapshot("PENDING_REMOTE_VALIDATION"),
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        user_id: representativeMatrixUserId,
      }))
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"));

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([
      `${roomId}:${representativeMatrixUserId}:join_timeout`,
    ]);
    expect(mockRecordMatrixRoomRemoteValidationFailure).toHaveBeenCalledWith({
      roomId,
      errorCode: "matrix_join_timeout",
      retryable: true,
      expectedSecurityState: "PENDING_REMOTE_VALIDATION",
      eventId: "$invite-1",
    });
  });

  it("returns terminal success when a transient join exhausts its durable retry budget", async () => {
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue(
      securitySnapshot("PENDING_REMOTE_VALIDATION"),
    );
    mockRecordMatrixRoomRemoteValidationFailure.mockResolvedValueOnce({
      status: "isolated",
      attemptCount: 5,
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        user_id: representativeMatrixUserId,
      }))
      .mockResolvedValueOnce(new Response("", { status: 502 }));

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([]);
  });

  it("does not degrade health for a stale join failure after another replay wins", async () => {
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue(
      securitySnapshot("PENDING_REMOTE_VALIDATION"),
    );
    mockRecordMatrixRoomRemoteValidationFailure.mockResolvedValueOnce({
      status: "ignored",
      attemptCount: 0,
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        user_id: representativeMatrixUserId,
      }))
      .mockResolvedValueOnce(new Response("", { status: 403 }));

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([]);
    expect(mockRecordMatrixRuntimeHealth).not.toHaveBeenCalled();
  });

  it("counts a duplicate invite only once per transaction delivery", async () => {
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue(
      securitySnapshot("PENDING_REMOTE_VALIDATION"),
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        user_id: representativeMatrixUserId,
      }))
      .mockResolvedValueOnce(new Response("", { status: 502 }));

    await expect(
      joinManagedMatrixInvites([
        directInviteEvent(),
        { ...directInviteEvent(), event_id: "$invite-duplicate" },
      ]),
    ).resolves.toEqual([
      `${roomId}:${representativeMatrixUserId}:502`,
    ]);
    expect(mockRecordMatrixRoomRemoteValidationFailure).toHaveBeenCalledOnce();
  });

  it("defers content ingestion while a durable invite join retry is pending", async () => {
    mockIngestMatrixApplicationServiceTransaction.mockResolvedValueOnce([
      { eventId: "$invite-1", status: "processed" },
    ]);
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue(
      securitySnapshot("PENDING_REMOTE_VALIDATION"),
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("", { status: 502 }),
    );

    await expect(processMatrixApplicationServiceTransaction({
      transactionId: "txn-pending-join",
      events: [directInviteEvent(), matrixMessageEvent()],
    })).resolves.toBe("join_retry");

    expect(
      mockIngestMatrixApplicationServiceTransaction,
    ).toHaveBeenCalledOnce();
    expect(
      mockIngestMatrixApplicationServiceTransaction,
    ).toHaveBeenCalledWith({
      transactionId: "txn-pending-join",
      events: [directInviteEvent()],
    });
  });

  it("registers the managed virtual user before joining the room", async () => {
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue(
      securitySnapshot("PENDING_REMOTE_VALIDATION"),
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ user_id: representativeMatrixUserId }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        joined: {
          [audienceMatrixUserId]: {},
          [representativeMatrixUserId]: {},
        },
      }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    mockActivateVerifiedMatrixDirectConversation.mockResolvedValue(true);

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([]);

    const [registrationUrl, registrationRequest] =
      vi.mocked(fetch).mock.calls[0]!;
    expect(String(registrationUrl)).toBe(
      "https://matrix.example.org/_matrix/client/v3/register",
    );
    expect(registrationRequest).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        type: "m.login.application_service",
        username: "_delegate_rep",
        inhibit_login: true,
      }),
    });
    expect(new Headers(registrationRequest?.headers).get("authorization")).toBe(
      "Bearer application-service-token",
    );
  });

  it("keeps a pending room retryable when virtual-user registration fails", async () => {
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue(
      securitySnapshot("PENDING_REMOTE_VALIDATION"),
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("", { status: 502 }),
    );

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([
      `${roomId}:${representativeMatrixUserId}:register_502`,
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockActivateVerifiedMatrixDirectConversation).not.toHaveBeenCalled();
    expect(mockIsolateMatrixConversationRoom).not.toHaveBeenCalled();
    expect(mockRecordMatrixRuntimeHealth).toHaveBeenCalledWith({
      matrixUserId: representativeMatrixUserId,
      status: "DEGRADED",
      errorCode: "matrix_runtime_register_502",
      expectedAssignmentRevision: 1,
    });
  });

  it("terminally isolates a virtual user whose server differs only by case", async () => {
    mockGetMatrixVirtualUserBinding.mockResolvedValue({
      matrixUserId: "@_delegate_rep:EXAMPLE.ORG",
      representativeId: "representative-1",
      endpointAssignmentRevision: 1,
    });
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue({
      ...securitySnapshot("PENDING_REMOTE_VALIDATION"),
      representativeMatrixUserId: "@_delegate_rep:EXAMPLE.ORG",
    });

    await expect(
      joinManagedMatrixInvites([{
        ...directInviteEvent(),
        state_key: "@_delegate_rep:EXAMPLE.ORG",
      }]),
    ).resolves.toEqual([]);

    expect(fetch).not.toHaveBeenCalled();
    expect(mockRecordMatrixRoomRemoteValidationFailure).toHaveBeenCalledWith({
      roomId,
      errorCode: "virtual_user_server_mismatch",
      retryable: false,
      expectedSecurityState: "PENDING_REMOTE_VALIDATION",
      eventId: "$invite-1",
    });
  });

  it("does not isolate when another replay activates the same pending room first", async () => {
    mockGetMatrixRoomSecuritySnapshot
      .mockResolvedValueOnce(securitySnapshot("PENDING_REMOTE_VALIDATION"))
      .mockResolvedValueOnce(securitySnapshot("ACTIVE"));
    vi.mocked(fetch)
      .mockResolvedValueOnce(matrixUserInUseResponse())
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        joined: {
          [audienceMatrixUserId]: {},
          [representativeMatrixUserId]: {},
        },
      }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    mockActivateVerifiedMatrixDirectConversation.mockResolvedValue(false);

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([]);

    expect(mockIsolateMatrixConversationRoom).not.toHaveBeenCalled();
  });

  it("does not isolate when disconnect wins after the remote join", async () => {
    mockGetMatrixRoomSecuritySnapshot
      .mockResolvedValueOnce(securitySnapshot("PENDING_REMOTE_VALIDATION"))
      .mockResolvedValueOnce({
        ...securitySnapshot("PENDING_REMOTE_VALIDATION"),
        representativeChannelDesiredState: "DISCONNECTED",
      });
    vi.mocked(fetch)
      .mockResolvedValueOnce(matrixUserInUseResponse())
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        joined: {
          [audienceMatrixUserId]: {},
          [representativeMatrixUserId]: {},
        },
      }))
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    mockActivateVerifiedMatrixDirectConversation.mockResolvedValue(false);

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([]);

    expect(mockIsolateMatrixConversationRoom).not.toHaveBeenCalled();
    expect(mockRecordMatrixRuntimeHealth).not.toHaveBeenCalled();
    expect(String(vi.mocked(fetch).mock.calls[4]?.[0])).toContain(
      `/rooms/${encodeURIComponent(roomId)}/leave`,
    );
  });

  it("preserves a concurrent security event's isolation reason after the remote join", async () => {
    mockGetMatrixRoomSecuritySnapshot
      .mockResolvedValueOnce(securitySnapshot("PENDING_REMOTE_VALIDATION"))
      .mockResolvedValueOnce(securitySnapshot("ISOLATED"));
    vi.mocked(fetch)
      .mockResolvedValueOnce(matrixUserInUseResponse())
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        joined: {
          [audienceMatrixUserId]: {},
          [representativeMatrixUserId]: {},
        },
      }))
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    mockActivateVerifiedMatrixDirectConversation.mockResolvedValue(false);

    await expect(
      joinManagedMatrixInvites([directInviteEvent()]),
    ).resolves.toEqual([]);

    expect(mockIsolateMatrixConversationRoom).not.toHaveBeenCalled();
    expect(mockRecordMatrixRuntimeHealth).not.toHaveBeenCalled();
  });
});

describe("Matrix bridge readiness", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    mockCheckMatrixRuntimePersistenceReadiness.mockResolvedValue(true);
  });

  it("reports ready only when persistence, homeserver, and AS auth are healthy", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        user_id: "@_delegate_as:example.org",
      }));

    await expect(checkMatrixBridgeReadiness()).resolves.toEqual({
      ready: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://matrix.example.org/_matrix/client/versions"),
      expect.objectContaining({
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
    const [whoamiUrl, whoamiRequest] = vi.mocked(fetch).mock.calls[1]!;
    expect(String(whoamiUrl)).toBe(
      "https://matrix.example.org/_matrix/client/v3/account/whoami",
    );
    expect(
      new Headers(whoamiRequest?.headers).get("authorization"),
    ).toBe("Bearer application-service-token");
  });

  it("fails readiness when Matrix persistence is unavailable", async () => {
    mockCheckMatrixRuntimePersistenceReadiness.mockResolvedValue(false);

    await expect(checkMatrixBridgeReadiness()).resolves.toEqual({
      ready: false,
      reason: "matrix_persistence_unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed without exposing homeserver response details", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("provider detail", { status: 502 }),
    );

    await expect(checkMatrixBridgeReadiness()).resolves.toEqual({
      ready: false,
      reason: "matrix_homeserver_unhealthy",
    });
  });

  it("reports an unreachable homeserver as not ready", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("secret internal URL"));

    await expect(checkMatrixBridgeReadiness()).resolves.toEqual({
      ready: false,
      reason: "matrix_homeserver_unreachable",
    });
  });

  it("fails readiness when the AS token is rejected", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 401 }));

    await expect(checkMatrixBridgeReadiness()).resolves.toEqual({
      ready: false,
      reason: "matrix_application_service_auth_unhealthy",
    });
  });

  it("fails readiness when AS identity belongs to another server", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        user_id: "@_delegate_as:EXAMPLE.ORG",
      }));

    await expect(checkMatrixBridgeReadiness()).resolves.toEqual({
      ready: false,
      reason: "matrix_application_service_identity_mismatch",
    });
  });

  it("fails readiness when the token belongs to another AS on the same server", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        user_id: "@another_application_service:example.org",
      }));

    await expect(checkMatrixBridgeReadiness()).resolves.toEqual({
      ready: false,
      reason: "matrix_application_service_identity_mismatch",
    });
  });
});

describe("active Matrix room revalidation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue(
      securitySnapshot("ACTIVE"),
    );
    mockIsolateMatrixConversationRoom.mockResolvedValue(true);
    mockClearMatrixRoomRemoteValidationFailures.mockResolvedValue(false);
    mockRecordMatrixRoomRemoteValidationFailure.mockImplementation(
      async (input: { retryable: boolean }) => (
        input.retryable
          ? { status: "retry_scheduled", attemptCount: 1 }
          : { status: "isolated", attemptCount: 1 }
      ),
    );
    mockRecordMatrixRuntimeHealth.mockResolvedValue(true);
  });

  it("accepts a still-plaintext exact two-member room", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        joined: {
          [audienceMatrixUserId]: {},
          [representativeMatrixUserId]: {},
        },
      }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));

    await expect(validateActiveMatrixRoomsBeforeIngest([
      matrixMessageEvent(),
    ])).resolves.toEqual([]);
    expect(mockIsolateMatrixConversationRoom).not.toHaveBeenCalled();
  });

  it("clears a prior transient failure streak after authoritative success", async () => {
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue({
      ...securitySnapshot("ACTIVE"),
      remoteValidationAttemptCount: 2,
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        joined: {
          [audienceMatrixUserId]: {},
          [representativeMatrixUserId]: {},
        },
      }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));

    await expect(validateActiveMatrixRoomsBeforeIngest([
      matrixMessageEvent(),
    ])).resolves.toEqual([]);
    expect(
      mockClearMatrixRoomRemoteValidationFailures,
    ).toHaveBeenCalledWith(roomId);
  });

  it("isolates a room before ingest when a third member is authoritative", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      joined: {
        [audienceMatrixUserId]: {},
        [representativeMatrixUserId]: {},
        "@mallory:example.org": {},
      },
    }));

    await expect(validateActiveMatrixRoomsBeforeIngest([
      matrixMessageEvent(),
    ])).resolves.toEqual([]);
    expect(mockRecordMatrixRoomRemoteValidationFailure).toHaveBeenCalledWith({
      roomId,
      errorCode: "joined_members_not_exactly_direct",
      retryable: false,
      expectedSecurityState: "ACTIVE",
      eventId: "$message-1",
    });
    expect(mockRecordMatrixRuntimeHealth).toHaveBeenCalledWith({
      matrixUserId: representativeMatrixUserId,
      status: "DEGRADED",
      errorCode: "matrix_runtime_joined_members_not_exactly_direct",
      expectedAssignmentRevision: 1,
    });
  });

  it("requests a retry instead of trusting an unavailable remote check", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("", { status: 502 }),
    );

    await expect(validateActiveMatrixRoomsBeforeIngest([
      matrixMessageEvent(),
    ])).resolves.toEqual([
      `${roomId}:joined_members_502`,
    ]);
    expect(mockIsolateMatrixConversationRoom).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])(
    "terminally isolates an inaccessible joined_members response %s",
    async (status) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response("", { status }),
      );

      await expect(validateActiveMatrixRoomsBeforeIngest([
        matrixMessageEvent(),
      ])).resolves.toEqual([]);

      expect(mockRecordMatrixRoomRemoteValidationFailure).toHaveBeenCalledWith({
        roomId,
        errorCode: `joined_members_${status}`,
        retryable: false,
        expectedSecurityState: "ACTIVE",
        eventId: "$message-1",
      });
    },
  );

  it("stops retrying transient joined_members failures after durable exhaustion", async () => {
    mockRecordMatrixRoomRemoteValidationFailure.mockResolvedValueOnce({
      status: "isolated",
      attemptCount: 5,
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("", { status: 503 }),
    );

    await expect(validateActiveMatrixRoomsBeforeIngest([
      matrixMessageEvent(),
    ])).resolves.toEqual([]);
  });

  it.each([
    {
      type: "m.room.member",
      content: { membership: "leave" },
      state_key: audienceMatrixUserId,
    },
    {
      type: "m.room.encryption",
      content: { algorithm: "m.megolm.v1.aes-sha2" },
      state_key: "",
    },
  ])("never pre-validates $type security events", async (securityEvent) => {
    await expect(validateActiveMatrixRoomsBeforeIngest([{
      event_id: "$security-1",
      room_id: roomId,
      sender: audienceMatrixUserId,
      ...securityEvent,
    }])).resolves.toEqual([]);

    expect(mockGetMatrixRoomSecuritySnapshot).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets a same-room security event bypass stale content pre-validation", async () => {
    await expect(validateActiveMatrixRoomsBeforeIngest([
      matrixMessageEvent(),
      {
        event_id: "$member-1",
        type: "m.room.member",
        room_id: roomId,
        sender: audienceMatrixUserId,
        state_key: audienceMatrixUserId,
        content: { membership: "leave" },
      },
    ])).resolves.toEqual([]);

    expect(mockGetMatrixRoomSecuritySnapshot).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("durably ingests cross-room security events before a content validation retry", async () => {
    mockIngestMatrixApplicationServiceTransaction.mockResolvedValueOnce([
      { eventId: "$member-1", status: "processed" },
    ]);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("", { status: 502 }),
    );

    await expect(processMatrixApplicationServiceTransaction({
      transactionId: "txn-security-first",
      events: [
        matrixMessageEvent(),
        {
          event_id: "$member-1",
          type: "m.room.member",
          room_id: "!other:example.org",
          sender: "@bob:example.org",
          state_key: "@bob:example.org",
          content: { membership: "leave" },
        },
      ],
    })).resolves.toBe("validation_retry");

    expect(
      mockIngestMatrixApplicationServiceTransaction,
    ).toHaveBeenCalledOnce();
    expect(
      mockIngestMatrixApplicationServiceTransaction,
    ).toHaveBeenCalledWith({
      transactionId: "txn-security-first",
      events: [
        expect.objectContaining({
          event_id: "$member-1",
          type: "m.room.member",
        }),
      ],
    });
  });
});

function directInviteEvent() {
  return {
    event_id: "$invite-1",
    type: "m.room.member",
    room_id: roomId,
    sender: audienceMatrixUserId,
    state_key: representativeMatrixUserId,
    content: {
      membership: "invite",
      is_direct: true,
    },
  };
}

function matrixMessageEvent() {
  return {
    event_id: "$message-1",
    type: "m.room.message",
    room_id: roomId,
    sender: audienceMatrixUserId,
    content: {
      msgtype: "m.text",
      body: "hello",
    },
  };
}

function securitySnapshot(
  securityState: "PENDING_REMOTE_VALIDATION" | "ACTIVE" | "ISOLATED",
) {
  return {
    bindingId: "matrix-binding-1",
    conversationId: "conversation-1",
    securityState,
    remoteValidationAttemptCount: 0,
    audienceMatrixUserId,
    representativeMatrixUserId,
    representativeAssignmentRevision: 1,
    currentRepresentativeAssignmentRevision: 1,
    representativeChannelDesiredState: "ACTIVE",
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function matrixUserInUseResponse() {
  return new Response(JSON.stringify({ errcode: "M_USER_IN_USE" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}
