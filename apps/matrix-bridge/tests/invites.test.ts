import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockActivateVerifiedMatrixDirectConversation,
  mockGetMatrixRoomSecuritySnapshot,
  mockGetMatrixVirtualUserBinding,
  mockIngestMatrixApplicationServiceTransaction,
  mockIsolateMatrixConversationRoom,
} = vi.hoisted(() => {
  process.env.MATRIX_AS_HS_TOKEN = "homeserver-token-that-is-long-enough";
  process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.org";
  process.env.MATRIX_AS_TOKEN = "application-service-token";
  process.env.MATRIX_SERVER_NAME = "example.org";
  return {
    mockActivateVerifiedMatrixDirectConversation: vi.fn(),
    mockGetMatrixRoomSecuritySnapshot: vi.fn(),
    mockGetMatrixVirtualUserBinding: vi.fn(),
    mockIngestMatrixApplicationServiceTransaction: vi.fn(),
    mockIsolateMatrixConversationRoom: vi.fn(),
  };
});

vi.mock("@delegate/web-data", () => ({
  activateVerifiedMatrixDirectConversation:
    mockActivateVerifiedMatrixDirectConversation,
  getMatrixRoomSecuritySnapshot: mockGetMatrixRoomSecuritySnapshot,
  getMatrixVirtualUserBinding: mockGetMatrixVirtualUserBinding,
  ingestMatrixApplicationServiceTransaction:
    mockIngestMatrixApplicationServiceTransaction,
  isolateMatrixConversationRoom: mockIsolateMatrixConversationRoom,
}));

import { joinManagedMatrixInvites } from "../src/index";

const roomId = "!room:example.org";
const audienceMatrixUserId = "@alice:example.org";
const representativeMatrixUserId = "@_delegate_rep:example.org";

describe("managed Matrix invite joining", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetMatrixVirtualUserBinding.mockResolvedValue({
      matrixUserId: representativeMatrixUserId,
    });
    mockIsolateMatrixConversationRoom.mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn());
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

    vi.mocked(fetch).mockReset();
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
  });

  it("does not register or join a virtual user from another server", async () => {
    mockGetMatrixVirtualUserBinding.mockResolvedValue({
      matrixUserId: "@_delegate_rep:other.example.org",
    });
    mockGetMatrixRoomSecuritySnapshot.mockResolvedValue({
      ...securitySnapshot("PENDING_REMOTE_VALIDATION"),
      representativeMatrixUserId: "@_delegate_rep:other.example.org",
    });

    await expect(
      joinManagedMatrixInvites([{
        ...directInviteEvent(),
        state_key: "@_delegate_rep:other.example.org",
      }]),
    ).resolves.toEqual([
      `${roomId}:@_delegate_rep:other.example.org:virtual_user_server_mismatch`,
    ]);

    expect(fetch).not.toHaveBeenCalled();
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

function securitySnapshot(
  securityState: "PENDING_REMOTE_VALIDATION" | "ACTIVE" | "ISOLATED",
) {
  return {
    bindingId: "matrix-binding-1",
    conversationId: "conversation-1",
    securityState,
    audienceMatrixUserId,
    representativeMatrixUserId,
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
