import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generatedPrismaClientHasFields: vi.fn(),
  preflightWeChatPayRuntime: vi.fn(),
  queryRaw: vi.fn(),
}));

const validAccountIndexes = [
  { indexName: "Owner_accountId_key" },
  { indexName: "AudienceIdentity_accountId_key" },
];

vi.mock("@delegate/web-data", () => ({
  generatedPrismaClientHasFields:
    mocks.generatedPrismaClientHasFields,
  preflightWeChatPayRuntime:
    mocks.preflightWeChatPayRuntime,
  prisma: {
    $queryRaw: mocks.queryRaw,
  },
}));

import { GET } from "../app/ready/route";

describe("representative app readiness route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generatedPrismaClientHasFields.mockReturnValue(true);
    mocks.queryRaw.mockImplementation((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join(" ").includes("pg_index")
          ? validAccountIndexes
          : [],
      )
    );
    mocks.preflightWeChatPayRuntime.mockReturnValue({
      ready: true,
      status: "disabled",
      collectionEnabled: false,
      processingEnabled: false,
      errorCode: null,
    });
  });

  it("is ready when the database is reachable and payment is intentionally disabled", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      service: "reps",
      databaseReady: true,
      weChatPay: {
        status: "disabled",
      },
    });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    const sql = mocks.queryRaw.mock.calls[0]?.[0]?.join(" ") ?? "";
    expect(sql).toContain('owner_contract."accountDisplayName"');
    expect(sql).toContain('owner_contract."accountId"');
    expect(sql).toContain('audience_identity_contract."accountId"');
    expect(sql).toContain('account_contract."status"');
    expect(sql).toContain('auth_identity_contract."accountId"');
    expect(sql).toContain('auth_identity_contract."issuer"');
    expect(sql).toContain('auth_identity_contract."subject"');
    expect(sql).toContain('app_session_contract."accountId"');
    expect(sql).toContain('app_session_contract."authIdentityId"');
    expect(sql).toContain('app_session_contract."application"');
    expect(sql).toContain('owner_identity_contract."issuer"');
    expect(sql).toContain(
      'representative_binding_contract."endpointAssignmentRevision"',
    );
    expect(sql).toContain(
      'conversation_binding_contract."representativeAssignmentRevision"',
    );
    expect(sql).toMatch(/\bLIMIT\s+0\b/u);
    const indexSql = mocks.queryRaw.mock.calls[1]?.[0]?.join(" ") ?? "";
    expect(indexSql).toContain("Owner_accountId_key");
    expect(indexSql).toContain("AudienceIdentity_accountId_key");
    expect(indexSql).toContain("index_state.indisvalid");
    expect(indexSql).toContain("index_state.indisready");
    expect(indexSql).toContain("index_state.indislive");
    expect(indexSql).toContain("index_state.indisunique");
    expect(indexSql).toContain(
      "pg_get_indexdef(index_state.indexrelid, 1, true)",
    );
  });

  it("fails readiness with a redacted payment configuration code", async () => {
    mocks.preflightWeChatPayRuntime.mockReturnValue({
      ready: false,
      status: "misconfigured",
      collectionEnabled: false,
      processingEnabled: true,
      errorCode: "wechat_pay_configuration_invalid",
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      databaseReady: true,
      weChatPay: {
        errorCode: "wechat_pay_configuration_invalid",
      },
    });
    expect(JSON.stringify(body)).not.toContain("private-key");
  });

  it("fails readiness without exposing a database error", async () => {
    mocks.queryRaw.mockRejectedValue(
      new Error("postgres-secret-host"),
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      databaseReady: false,
    });
    expect(JSON.stringify(body)).not.toContain(
      "postgres-secret-host",
    );
  });

  it("fails readiness when an account identity index is missing or invalid", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { indexName: "Owner_accountId_key" },
      ]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      databaseReady: false,
    });
  });

  it("fails readiness when the generated Prisma Client is behind the schema", async () => {
    mocks.generatedPrismaClientHasFields.mockReturnValue(false);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      databaseReady: false,
    });
    expect(JSON.stringify(body)).not.toContain(
      "endpointAssignmentRevision",
    );
    expect(mocks.generatedPrismaClientHasFields).toHaveBeenCalledWith({
      Owner: ["accountDisplayName", "accountId"],
      AudienceIdentity: ["accountId"],
      Account: ["id", "status"],
      AuthIdentity: ["accountId", "issuer", "subject"],
      AppSession: ["accountId", "authIdentityId", "application"],
      OwnerIdentityLink: ["issuer"],
      RepresentativeChannelBinding: ["endpointAssignmentRevision"],
      ConversationChannelBinding: ["representativeAssignmentRevision"],
    });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
