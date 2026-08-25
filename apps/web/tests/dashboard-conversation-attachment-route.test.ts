import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dashboardAuthErrorResponse: vi.fn(),
  getOwnerConversationAttachmentDownload: vi.fn(),
  requireDashboardRepresentativeAccess: vi.fn(),
}));

vi.mock("@delegate/web-data", () => ({
  getOwnerConversationAttachmentDownload:
    mocks.getOwnerConversationAttachmentDownload,
}));
vi.mock("../app/api/dashboard/auth", () => ({
  dashboardAuthErrorResponse: mocks.dashboardAuthErrorResponse,
  requireDashboardRepresentativeAccess:
    mocks.requireDashboardRepresentativeAccess,
}));

import { GET } from "../app/api/dashboard/representatives/[slug]/conversations/[conversationId]/attachments/[attachmentId]/route";

describe("Owner conversation attachment download route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDashboardRepresentativeAccess.mockResolvedValue({
      ownerId: "owner-1",
    });
    mocks.dashboardAuthErrorResponse.mockReturnValue(null);
  });

  it("downloads only through the authenticated representative scope", async () => {
    mocks.getOwnerConversationAttachmentDownload.mockResolvedValue({
      buffer: Buffer.from("hello"),
      fileName: "需求说明.pdf",
      mimeType: "application/pdf",
    });

    const response = await GET(
      new Request(
        "http://localhost/api/dashboard/representatives/rep/conversations/conversation-1/attachments/attachment-1",
      ),
      {
        params: Promise.resolve({
          slug: "rep",
          conversationId: "conversation-1",
          attachmentId: "attachment-1",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''",
    );
    expect(mocks.getOwnerConversationAttachmentDownload).toHaveBeenCalledWith({
      representativeSlug: "rep",
      conversationId: "conversation-1",
      attachmentId: "attachment-1",
      ownerId: "owner-1",
    });
  });

  it("returns 404 without leaking whether another Owner has the attachment", async () => {
    mocks.getOwnerConversationAttachmentDownload.mockResolvedValue(null);

    const response = await GET(
      new Request(
        "http://localhost/api/dashboard/representatives/rep/conversations/conversation-1/attachments/missing",
      ),
      {
        params: Promise.resolve({
          slug: "rep",
          conversationId: "conversation-1",
          attachmentId: "missing",
        }),
      },
    );

    expect(response.status).toBe(404);
  });
});
