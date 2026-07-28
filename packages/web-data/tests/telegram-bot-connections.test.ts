import {
  ChannelDesiredState,
  ChannelHealthStatus,
  ChannelSourceProvider,
  ChannelTransport,
  RepresentativeChannelKind,
  TelegramBotConnectionScope,
  TelegramBotConnectionStatus,
  TelegramBotCredentialStatus,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  bootstrapLegacyTelegramBotConnectionFromEnv,
  createOrRotateOwnerTelegramBotConnection,
  listActiveTelegramBotRuntimeConfigs,
  listOwnerTelegramBotConnections,
  markTelegramBotRuntimeHealth,
  revokeOwnerTelegramBotConnection,
  resolveTelegramBotRuntimeCredential,
  rotateOwnerTelegramBotConnection,
  setOwnerTelegramBotConnectionStatus,
  unassignOwnerTelegramBotConnection,
  verifyTelegramBotToken,
} from "../src/telegram-bot-connections";

const keyEnv = {
  NODE_ENV: "test",
  CHANNEL_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"),
  CHANNEL_CREDENTIAL_MASTER_KEY_VERSION: "test-v1",
};
const tokenOne =
  "1234567890:abcdefghijklmnopqrstuvwxyzABCDE_12345";
const tokenTwo =
  "1234567890:ZYXWVUTSRQPONMLKJIHGFEDCBA_54321";
const tokenThree =
  "2222222222:abcdefghijklmnopqrstuvwxyzABCDE_22222";

type FakeCredential = {
  id: string;
  telegramBotConnectionId: string;
  version: number;
  ciphertext: Uint8Array | null;
  iv: Uint8Array | null;
  authTag: Uint8Array | null;
  keyVersion: string;
  algorithm: string;
  fingerprint: string;
  status: TelegramBotCredentialStatus;
  createdBy: string;
  requestId: string;
  idempotencyKey: string;
  activatedAt: Date | null;
  retiredAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type FakeConnection = {
  id: string;
  ownerId: string | null;
  scope: TelegramBotConnectionScope;
  botId: string;
  username: string | null;
  displayName: string | null;
  label: string | null;
  status: TelegramBotConnectionStatus;
  healthStatus: ChannelHealthStatus;
  activeCredentialId: string | null;
  credentialRevision: number;
  lastVerifiedAt: Date | null;
  lastHealthCheckAt: Date | null;
  lastError: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type FakeRepresentative = {
  id: string;
  ownerId: string;
  createdAt: Date;
};

type FakeBinding = {
  id: string;
  representativeId: string;
  kind: RepresentativeChannelKind;
  transport: ChannelTransport | null;
  sourceProvider: ChannelSourceProvider | null;
  connectionId: string | null;
  telegramBotConnectionId: string | null;
  desiredState: ChannelDesiredState;
  healthStatus: ChannelHealthStatus;
  externalUserId: string | null;
  status: string;
  configuration: Record<string, unknown> | null;
  lastHealthCheckAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type FakeAudit = {
  id: string;
  representativeId: string;
  payload: Record<string, unknown>;
};

function createFakeClient() {
  const owners = new Set(["owner-1", "owner-2"]);
  const connections: FakeConnection[] = [];
  const credentials: FakeCredential[] = [];
  const representatives: FakeRepresentative[] = [
    {
      id: "rep-1",
      ownerId: "owner-1",
      createdAt: new Date("2026-07-27T00:00:00.000Z"),
    },
    {
      id: "rep-2",
      ownerId: "owner-1",
      createdAt: new Date("2026-07-27T00:01:00.000Z"),
    },
    {
      id: "rep-owner-2",
      ownerId: "owner-2",
      createdAt: new Date("2026-07-27T00:00:00.000Z"),
    },
  ];
  const bindings: FakeBinding[] = [];
  const audits: FakeAudit[] = [];

  const enrich = (connection: FakeConnection) => ({
    ...connection,
    activeCredential:
      credentials.find(
        (credential) => credential.id === connection.activeCredentialId,
      ) ?? null,
    credentials: credentials.filter(
      (credential) =>
        credential.telegramBotConnectionId === connection.id,
    ),
    representativeBindings: bindings.filter(
      (binding) => binding.telegramBotConnectionId === connection.id,
    ),
  });
  const selectConnection = (
    connection: FakeConnection,
    args: {
      include?: {
        credentials?: { where?: { idempotencyKey?: string } };
      };
      select?: {
        credentials?: { where?: { idempotencyKey?: string } };
      };
    } = {},
  ) => {
    const result = enrich(connection);
    const idempotencyKey =
      args.include?.credentials?.where?.idempotencyKey
      ?? args.select?.credentials?.where?.idempotencyKey;
    return idempotencyKey
      ? {
          ...result,
          credentials: result.credentials.filter(
            (credential) =>
              credential.idempotencyKey === idempotencyKey,
          ),
        }
      : result;
  };
  const matchesConnectionWhere = (
    connection: FakeConnection,
    where: Record<string, unknown>,
  ) => {
    if (
      typeof where.id === "string"
      && connection.id !== where.id
    ) return false;
    if (
      typeof where.botId === "string"
      && connection.botId !== where.botId
    ) return false;
    if (
      typeof where.ownerId === "string"
      && connection.ownerId !== where.ownerId
    ) return false;
    if (
      where.ownerId
      && typeof where.ownerId === "object"
      && "not" in where.ownerId
      && connection.ownerId === null
    ) return false;
    if (
      typeof where.scope === "string"
      && connection.scope !== where.scope
    ) return false;
    if (
      where.scope
      && typeof where.scope === "object"
      && "in" in where.scope
      && Array.isArray(where.scope.in)
      && !where.scope.in.includes(connection.scope)
    ) return false;
    if (
      typeof where.status === "string"
      && connection.status !== where.status
    ) return false;
    if (
      "revokedAt" in where
      && where.revokedAt === null
      && connection.revokedAt !== null
    ) return false;
    if (
      "activeCredentialId" in where
      && typeof where.activeCredentialId !== "object"
      && connection.activeCredentialId !== where.activeCredentialId
    ) return false;
    if (
      typeof where.credentialRevision === "number"
      && connection.credentialRevision !== where.credentialRevision
    ) return false;
    if (
      Array.isArray(where.OR)
      && !where.OR.some((selector) =>
        matchesConnectionWhere(
          connection,
          selector as Record<string, unknown>,
        )
      )
    ) return false;
    return true;
  };
  const matchesBindingWhere = (
    binding: FakeBinding,
    where: Record<string, unknown>,
  ) => {
    if (typeof where.id === "string" && binding.id !== where.id) {
      return false;
    }
    if (
      typeof where.representativeId === "string"
      && binding.representativeId !== where.representativeId
    ) return false;
    if (
      typeof where.kind === "string"
      && binding.kind !== where.kind
    ) return false;
    if (
      "telegramBotConnectionId" in where
      && binding.telegramBotConnectionId
        !== where.telegramBotConnectionId
    ) return false;
    if (
      "connectionId" in where
      && binding.connectionId !== where.connectionId
    ) return false;
    if (
      typeof where.desiredState === "string"
      && binding.desiredState !== where.desiredState
    ) return false;
    if (
      where.representative
      && typeof where.representative === "object"
      && "ownerId" in where.representative
    ) {
      const representative = representatives.find(
        (candidate) => candidate.id === binding.representativeId,
      );
      if (
        !representative
        || representative.ownerId !== where.representative.ownerId
      ) return false;
    }
    return true;
  };
  const findPayloadFilter = (
    where: Record<string, unknown>,
    field: string,
  ) => {
    const filters = Array.isArray(where.AND) ? where.AND : [];
    for (const filter of filters) {
      if (!filter || typeof filter !== "object") continue;
      const payload = (filter as {
        payload?: { path?: string[]; equals?: unknown };
      }).payload;
      if (payload?.path?.[0] === field) return payload.equals;
    }
    return undefined;
  };

  const client = {
    $executeRaw: async () => 1,
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) =>
      callback(client),
    owner: {
      findUnique: async (args: { where: { id: string } }) =>
        owners.has(args.where.id) ? { id: args.where.id } : null,
    },
    representative: {
      findFirst: async (args: {
        where: { ownerId: string };
      }) =>
        representatives
          .filter(
            (representative) =>
              representative.ownerId === args.where.ownerId,
          )
          .sort(
            (left, right) =>
              left.createdAt.getTime() - right.createdAt.getTime()
              || left.id.localeCompare(right.id),
          )[0] ?? null,
    },
    telegramBotConnection: {
      create: async (args: {
        data: Omit<
          FakeConnection,
          | "createdAt"
          | "updatedAt"
          | "activeCredentialId"
          | "lastHealthCheckAt"
          | "lastError"
          | "revokedAt"
        > & Partial<
          Pick<
            FakeConnection,
            | "activeCredentialId"
            | "lastHealthCheckAt"
            | "lastError"
            | "revokedAt"
          >
        >;
      }) => {
        const now = new Date();
        const connection: FakeConnection = {
          activeCredentialId: null,
          lastHealthCheckAt: null,
          lastError: null,
          revokedAt: null,
          ...args.data,
          createdAt: now,
          updatedAt: now,
        };
        connections.push(connection);
        return selectConnection(connection);
      },
      findUnique: async (args: {
        where: { botId?: string; id?: string };
        include?: {
          credentials?: { where?: { idempotencyKey?: string } };
        };
        select?: {
          credentials?: { where?: { idempotencyKey?: string } };
        };
      }) => {
        const connection = connections.find(
          (candidate) =>
            candidate.botId === args.where.botId
            || candidate.id === args.where.id,
        );
        return connection
          ? selectConnection(connection, args)
          : null;
      },
      findFirst: async (args: {
        where: Record<string, unknown>;
        select?: {
          credentials?: { where?: { idempotencyKey?: string } };
        };
      }) => {
        const connection = connections.find((candidate) =>
          matchesConnectionWhere(candidate, args.where)
        );
        return connection ? selectConnection(connection, args) : null;
      },
      findMany: async (args: {
        where?: { ownerId?: string; status?: TelegramBotConnectionStatus };
      }) =>
        connections
          .filter((connection) =>
            !args.where?.ownerId
            || connection.ownerId === args.where.ownerId
          )
          .filter((connection) =>
            !args.where?.status
            || connection.status === args.where.status
          )
          .map((connection) => selectConnection(connection)),
      count: async () => connections.length,
      update: async (args: {
        where: { id: string };
        data: Partial<FakeConnection>;
      }) => {
        const connection = connections.find(
          (candidate) => candidate.id === args.where.id,
        );
        if (!connection) throw new Error("connection not found");
        Object.assign(connection, args.data, { updatedAt: new Date() });
        return selectConnection(connection);
      },
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Partial<FakeConnection>;
      }) => {
        const connection = connections.find(
          (candidate) =>
            matchesConnectionWhere(candidate, args.where),
        );
        if (!connection) return { count: 0 };
        Object.assign(connection, args.data, { updatedAt: new Date() });
        return { count: 1 };
      },
    },
    telegramBotCredential: {
      create: async (args: {
        data: Omit<FakeCredential, "id" | "createdAt" | "updatedAt" | "retiredAt" | "revokedAt">;
      }) => {
        const now = new Date();
        const credential: FakeCredential = {
          ...args.data,
          id: `credential-${credentials.length + 1}`,
          retiredAt: null,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        credentials.push(credential);
        return credential;
      },
      update: async (args: {
        where: { id: string };
        data: Partial<FakeCredential>;
      }) => {
        const credential = credentials.find(
          (candidate) => candidate.id === args.where.id,
        );
        if (!credential) throw new Error("credential not found");
        Object.assign(credential, args.data, { updatedAt: new Date() });
        return credential;
      },
      updateMany: async (args: {
        where: {
          id?: string;
          telegramBotConnectionId?: string;
          version?: number;
          status?: TelegramBotCredentialStatus;
        };
        data: Partial<FakeCredential>;
      }) => {
        let count = 0;
        for (const credential of credentials) {
          if (
            args.where.id
            && credential.id !== args.where.id
          ) continue;
          if (
            args.where.telegramBotConnectionId
            && credential.telegramBotConnectionId
              !== args.where.telegramBotConnectionId
          ) continue;
          if (
            args.where.version !== undefined
            && credential.version !== args.where.version
          ) continue;
          if (
            args.where.status
            && credential.status !== args.where.status
          ) continue;
          Object.assign(credential, args.data, {
            updatedAt: new Date(),
          });
          count += 1;
        }
        return { count };
      },
    },
    representativeChannelBinding: {
      findMany: async (args: {
        where: Record<string, unknown>;
      }) =>
        bindings
          .filter((binding) =>
            matchesBindingWhere(binding, args.where)
          )
          .sort(
            (left, right) =>
              left.createdAt.getTime() - right.createdAt.getTime()
              || left.id.localeCompare(right.id),
          ),
      findFirst: async (args: {
        where: Record<string, unknown>;
      }) => {
        const binding = bindings.find((candidate) =>
          matchesBindingWhere(candidate, args.where)
        );
        return binding ? { ...binding } : null;
      },
      findUnique: async (args: {
        where: { id: string };
      }) => {
        const binding = bindings.find(
          (candidate) => candidate.id === args.where.id,
        );
        return binding ? { ...binding } : null;
      },
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Partial<FakeBinding>;
      }) => {
        let count = 0;
        for (const binding of bindings) {
          if (!matchesBindingWhere(binding, args.where)) continue;
          Object.assign(binding, args.data, {
            updatedAt: new Date(),
          });
          count += 1;
        }
        return { count };
      },
    },
    eventAudit: {
      findFirst: async (args: {
        where: Record<string, unknown>;
      }) => {
        const auditScope = findPayloadFilter(args.where, "auditScope");
        const action = findPayloadFilter(args.where, "action");
        const connectionId = findPayloadFilter(
          args.where,
          "connectionId",
        );
        const bindingId = findPayloadFilter(args.where, "bindingId");
        const idempotencyKey = findPayloadFilter(
          args.where,
          "idempotencyKey",
        );
        return audits.find((audit) => {
          const representative = representatives.find(
            (candidate) => candidate.id === audit.representativeId,
          );
          if (
            typeof args.where.representativeId === "string"
            && audit.representativeId !== args.where.representativeId
          ) return false;
          if (
            args.where.representative
            && typeof args.where.representative === "object"
            && "ownerId" in args.where.representative
            && representative?.ownerId
              !== args.where.representative.ownerId
          ) return false;
          return (
            (
              auditScope === undefined
              || audit.payload.auditScope === auditScope
            )
            && (action === undefined || audit.payload.action === action)
            && (
              connectionId === undefined
              || audit.payload.connectionId === connectionId
            )
            && (
              bindingId === undefined
              || audit.payload.bindingId === bindingId
            )
            && (
              idempotencyKey === undefined
              || audit.payload.idempotencyKey === idempotencyKey
            )
          );
        }) ?? null;
      },
      create: async (args: {
        data: {
          representativeId: string;
          payload: Record<string, unknown>;
        };
      }) => {
        const audit = {
          id: `audit-${audits.length + 1}`,
          representativeId: args.data.representativeId,
          payload: args.data.payload,
        };
        audits.push(audit);
        return audit;
      },
    },
  };

  return {
    client,
    connections,
    credentials,
    bindings,
    representatives,
    audits,
  };
}

function addTelegramBinding(
  fake: ReturnType<typeof createFakeClient>,
  input: {
    id: string;
    representativeId: string;
    telegramBotConnectionId: string;
    botId?: string;
  },
) {
  const now = new Date("2026-07-27T05:30:00.000Z");
  const binding: FakeBinding = {
    id: input.id,
    representativeId: input.representativeId,
    kind: RepresentativeChannelKind.TELEGRAM,
    transport: ChannelTransport.TELEGRAM,
    sourceProvider: ChannelSourceProvider.TELEGRAM,
    connectionId: input.botId ?? "1234567890",
    telegramBotConnectionId: input.telegramBotConnectionId,
    desiredState: ChannelDesiredState.ACTIVE,
    healthStatus: ChannelHealthStatus.HEALTHY,
    externalUserId: "@delegate_test_bot",
    status: "CONFIGURED",
    configuration: {
      managed: true,
      botUsername: "delegate_test_bot",
    },
    lastHealthCheckAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  fake.bindings.push(binding);
  return binding;
}

function getMeFetch(botId = "1234567890") {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        ok: true,
        result: {
          id: Number(botId),
          is_bot: true,
          first_name: "Delegate",
          username: "delegate_test_bot",
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )
  ) as unknown as typeof fetch;
}

describe("Telegram Bot connections", () => {
  it("creates, safely lists, resolves, and rotates an owner Bot", async () => {
    const fake = createFakeClient();
    const dependencies = {
      client: fake.client as never,
      env: keyEnv,
      fetchImpl: getMeFetch(),
      now: new Date("2026-07-27T05:00:00.000Z"),
    };
    const created = await createOrRotateOwnerTelegramBotConnection(
      {
        ownerId: "owner-1",
        actorId: "owner-1",
        token: tokenOne,
        label: "Support Bot",
        requestId: "request-create",
        idempotencyKey: "create-bot",
      },
      dependencies,
    );

    expect(created.created).toBe(true);
    expect(created.rotated).toBe(false);
    expect(created.connection).toMatchObject({
      botId: "1234567890",
      username: "delegate_test_bot",
      label: "Support Bot",
      credentialRevision: 1,
      referenceCount: 0,
    });
    expect(JSON.stringify(created)).not.toContain(tokenOne);
    expect(JSON.stringify(created)).not.toContain("ciphertext");

    await expect(
      createOrRotateOwnerTelegramBotConnection(
        {
          ownerId: "owner-1",
          actorId: "owner-1",
          token: tokenOne,
          label: "Support Bot",
          requestId: "request-create-replay",
          idempotencyKey: "create-bot",
        },
        dependencies,
      ),
    ).resolves.toMatchObject({
      created: true,
      rotated: false,
      connection: { label: "Support Bot" },
    });
    await expect(
      createOrRotateOwnerTelegramBotConnection(
        {
          ownerId: "owner-1",
          actorId: "owner-1",
          token: tokenOne,
          label: "Different label",
          requestId: "request-create-reused-label",
          idempotencyKey: "create-bot",
        },
        dependencies,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message:
        "Idempotency key was already used for a different Telegram Bot request on this resource.",
    });
    expect(fake.connections[0]?.label).toBe("Support Bot");

    const listed = await listOwnerTelegramBotConnections(
      { ownerId: "owner-1" },
      { client: fake.client as never },
    );
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(tokenOne);

    const resolved = await resolveTelegramBotRuntimeCredential(
      { connectionId: "1234567890" },
      { client: fake.client as never, env: keyEnv },
    );
    expect(resolved).toMatchObject({
      connectionId: created.connection.id,
      botId: "1234567890",
      token: tokenOne,
      credentialRevision: 1,
    });

    const rotated = await rotateOwnerTelegramBotConnection(
      {
        ownerId: "owner-1",
        actorId: "owner-1",
        telegramBotConnectionId: created.connection.id,
        token: tokenTwo,
        requestId: "request-rotate",
        idempotencyKey: "rotate-bot",
      },
      {
        ...dependencies,
        now: new Date("2026-07-27T05:05:00.000Z"),
      },
    );
    expect(rotated).toMatchObject({
      changed: true,
      replayed: false,
      rotated: true,
      connection: { credentialRevision: 2 },
    });
    expect(fake.credentials[0]).toMatchObject({
      ciphertext: null,
      iv: null,
      authTag: null,
      status: TelegramBotCredentialStatus.RETIRED,
    });
    expect(
      await resolveTelegramBotRuntimeCredential(
        { connectionId: created.connection.id },
        { client: fake.client as never, env: keyEnv },
      ),
    ).toMatchObject({ token: tokenTwo, credentialRevision: 2 });
  });

  it("disables and resumes an owner Bot with durable idempotent auditing", async () => {
    const fake = createFakeClient();
    const dependencies = {
      client: fake.client as never,
      env: keyEnv,
      fetchImpl: getMeFetch(),
    };
    const created = await createOrRotateOwnerTelegramBotConnection(
      {
        ownerId: "owner-1",
        actorId: "owner-1",
        token: tokenOne,
        requestId: "request-lifecycle-create",
        idempotencyKey: "lifecycle-create",
      },
      dependencies,
    );
    addTelegramBinding(fake, {
      id: "binding-rep-1",
      representativeId: "rep-1",
      telegramBotConnectionId: created.connection.id,
    });
    addTelegramBinding(fake, {
      id: "binding-rep-2",
      representativeId: "rep-2",
      telegramBotConnectionId: created.connection.id,
    });
    const disableInput = {
      ownerId: "owner-1",
      actorId: "owner-1",
      telegramBotConnectionId: created.connection.id,
      status: "DISABLED" as const,
      requestId: "request-disable",
      idempotencyKey: "disable-once",
    };

    const disabled = await setOwnerTelegramBotConnectionStatus(
      disableInput,
      {
        client: fake.client as never,
        now: new Date("2026-07-27T06:00:00.000Z"),
      },
    );
    expect(disabled).toMatchObject({
      changed: true,
      replayed: false,
      connection: {
        status: TelegramBotConnectionStatus.DISABLED,
      },
    });
    expect(fake.credentials[0]).toMatchObject({
      status: TelegramBotCredentialStatus.ACTIVE,
    });
    expect(fake.credentials[0]!.ciphertext).not.toBeNull();
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({
      representativeId: "rep-1",
      payload: {
        auditScope: "OWNER_TELEGRAM_BOT",
        action: "TELEGRAM_BOT_CONNECTION_DISABLED",
        connectionId: created.connection.id,
        affectedRepresentativeIds: ["rep-1", "rep-2"],
        referenceCount: 2,
        before: { status: TelegramBotConnectionStatus.ACTIVE },
        after: { status: TelegramBotConnectionStatus.DISABLED },
      },
    });

    await expect(
      setOwnerTelegramBotConnectionStatus(disableInput, {
        client: fake.client as never,
      }),
    ).resolves.toMatchObject({
      changed: false,
      replayed: true,
    });
    expect(fake.audits).toHaveLength(1);

    await expect(
      setOwnerTelegramBotConnectionStatus(
        {
          ...disableInput,
          status: "ACTIVE",
          requestId: "request-reused-for-resume",
        },
        { client: fake.client as never },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message:
        "Idempotency key was already used for a different Telegram Bot request on this resource.",
    });
    expect(fake.connections[0]!.status).toBe(
      TelegramBotConnectionStatus.DISABLED,
    );
    expect(fake.audits).toHaveLength(1);

    await expect(
      setOwnerTelegramBotConnectionStatus(
        {
          ...disableInput,
          ownerId: "owner-2",
          actorId: "owner-2",
          idempotencyKey: "cross-owner-disable",
        },
        { client: fake.client as never },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(fake.connections[0]!.status).toBe(
      TelegramBotConnectionStatus.DISABLED,
    );

    const resumed = await setOwnerTelegramBotConnectionStatus(
      {
        ...disableInput,
        status: "ACTIVE",
        requestId: "request-resume",
        idempotencyKey: "resume-once",
      },
      { client: fake.client as never },
    );
    expect(resumed).toMatchObject({
      changed: true,
      replayed: false,
      connection: {
        status: TelegramBotConnectionStatus.ACTIVE,
      },
    });
    expect(fake.audits.at(-1)?.payload).toMatchObject({
      action: "TELEGRAM_BOT_CONNECTION_RESUMED",
      before: { status: TelegramBotConnectionStatus.DISABLED },
      after: { status: TelegramBotConnectionStatus.ACTIVE },
    });
  });

  it("rotates only the exact Bot and preserves a disabled state and optional label", async () => {
    const fake = createFakeClient();
    const dependencies = {
      client: fake.client as never,
      env: keyEnv,
      fetchImpl: getMeFetch(),
    };
    const created = await createOrRotateOwnerTelegramBotConnection(
      {
        ownerId: "owner-1",
        actorId: "owner-1",
        token: tokenOne,
        label: "Original",
        requestId: "request-rotate-create",
        idempotencyKey: "rotate-create",
      },
      dependencies,
    );
    addTelegramBinding(fake, {
      id: "binding-rotate",
      representativeId: "rep-1",
      telegramBotConnectionId: created.connection.id,
    });
    await setOwnerTelegramBotConnectionStatus(
      {
        ownerId: "owner-1",
        actorId: "owner-1",
        telegramBotConnectionId: created.connection.id,
        status: "DISABLED",
        requestId: "request-rotate-disable",
        idempotencyKey: "rotate-disable",
      },
      { client: fake.client as never },
    );
    await expect(
      createOrRotateOwnerTelegramBotConnection(
        {
          ownerId: "owner-1",
          actorId: "owner-1",
          token: tokenTwo,
          requestId: "request-legacy-disabled-rotate",
          idempotencyKey: "legacy-disabled-rotate",
        },
        dependencies,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message:
        "Existing Telegram Bot credentials must be rotated through the lifecycle operation.",
    });
    expect(fake.connections[0]!.status).toBe(
      TelegramBotConnectionStatus.DISABLED,
    );
    expect(fake.credentials).toHaveLength(1);
    const rotateInput = {
      ownerId: "owner-1",
      actorId: "owner-1",
      telegramBotConnectionId: created.connection.id,
      token: tokenTwo,
      label: "Renamed",
      requestId: "request-explicit-rotate",
      idempotencyKey: "explicit-rotate",
    };

    const rotated = await rotateOwnerTelegramBotConnection(
      rotateInput,
      {
        ...dependencies,
        now: new Date("2026-07-27T06:10:00.000Z"),
      },
    );
    expect(rotated).toMatchObject({
      changed: true,
      replayed: false,
      rotated: true,
      connection: {
        status: TelegramBotConnectionStatus.DISABLED,
        label: "Renamed",
        credentialRevision: 2,
      },
    });
    expect(fake.credentials[0]).toMatchObject({
      ciphertext: null,
      iv: null,
      authTag: null,
      status: TelegramBotCredentialStatus.RETIRED,
    });
    expect(fake.credentials[1]).toMatchObject({
      version: 2,
      status: TelegramBotCredentialStatus.ACTIVE,
    });
    expect(fake.audits.at(-1)?.payload).toMatchObject({
      action: "TELEGRAM_BOT_TOKEN_ROTATED",
      before: {
        label: "Original",
        status: TelegramBotConnectionStatus.DISABLED,
        credentialRevision: 1,
      },
      after: {
        label: "Renamed",
        status: TelegramBotConnectionStatus.DISABLED,
        credentialRevision: 2,
      },
    });
    expect(JSON.stringify(fake.audits)).not.toContain(tokenTwo);

    const auditCount = fake.audits.length;
    await expect(
      rotateOwnerTelegramBotConnection(rotateInput, dependencies),
    ).resolves.toMatchObject({
      changed: false,
      replayed: true,
      rotated: false,
    });
    expect(fake.credentials).toHaveLength(2);
    expect(fake.audits).toHaveLength(auditCount);

    await expect(
      rotateOwnerTelegramBotConnection(
        {
          ...rotateInput,
          label: "Different label",
        },
        dependencies,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message:
        "Idempotency key was already used for a different Telegram Bot request on this resource.",
    });
    expect(fake.credentials).toHaveLength(2);
    expect(fake.audits).toHaveLength(auditCount);

    await expect(
      rotateOwnerTelegramBotConnection(
        {
          ...rotateInput,
          token: tokenOne,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message:
        "Idempotency key was already used for a different Telegram Bot credential.",
    });
    expect(fake.credentials).toHaveLength(2);
    expect(fake.audits).toHaveLength(auditCount);

    await expect(
      rotateOwnerTelegramBotConnection(
        {
          ...rotateInput,
          token: tokenThree,
          requestId: "request-wrong-bot",
          idempotencyKey: "wrong-bot",
        },
        {
          ...dependencies,
          fetchImpl: getMeFetch("2222222222"),
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Telegram Bot token belongs to a different Bot.",
    });
    expect(fake.credentials).toHaveLength(2);
    expect(fake.connections).toHaveLength(1);
    expect(JSON.stringify(fake.audits)).not.toMatch(
      /ciphertext|authTag|fingerprint/,
    );
  });

  it("irreversibly revokes credentials and clears every current representative reference", async () => {
    const fake = createFakeClient();
    const dependencies = {
      client: fake.client as never,
      env: keyEnv,
      fetchImpl: getMeFetch(),
    };
    const created = await createOrRotateOwnerTelegramBotConnection(
      {
        ownerId: "owner-1",
        actorId: "owner-1",
        token: tokenOne,
        requestId: "request-revoke-create",
        idempotencyKey: "revoke-create",
      },
      dependencies,
    );
    await rotateOwnerTelegramBotConnection(
      {
        ownerId: "owner-1",
        actorId: "owner-1",
        telegramBotConnectionId: created.connection.id,
        token: tokenTwo,
        requestId: "request-pre-revoke-rotate",
        idempotencyKey: "pre-revoke-rotate",
      },
      dependencies,
    );
    const firstBinding = addTelegramBinding(fake, {
      id: "binding-revoke-1",
      representativeId: "rep-1",
      telegramBotConnectionId: created.connection.id,
    });
    const secondBinding = addTelegramBinding(fake, {
      id: "binding-revoke-2",
      representativeId: "rep-2",
      telegramBotConnectionId: created.connection.id,
    });
    const revokeInput = {
      ownerId: "owner-1",
      actorId: "owner-1",
      telegramBotConnectionId: created.connection.id,
      requestId: "request-revoke",
      idempotencyKey: "revoke-once",
    };

    const revoked = await revokeOwnerTelegramBotConnection(
      revokeInput,
      {
        client: fake.client as never,
        now: new Date("2026-07-27T06:20:00.000Z"),
      },
    );
    expect(revoked).toMatchObject({
      changed: true,
      replayed: false,
      connection: {
        status: TelegramBotConnectionStatus.REVOKED,
        referenceCount: 0,
      },
    });
    expect(fake.connections[0]).toMatchObject({
      status: TelegramBotConnectionStatus.REVOKED,
      activeCredentialId: null,
      revokedAt: new Date("2026-07-27T06:20:00.000Z"),
    });
    for (const credential of fake.credentials) {
      expect(credential).toMatchObject({
        ciphertext: null,
        iv: null,
        authTag: null,
        status: TelegramBotCredentialStatus.REVOKED,
        revokedAt: new Date("2026-07-27T06:20:00.000Z"),
      });
    }
    for (const binding of [firstBinding, secondBinding]) {
      expect(binding).toMatchObject({
        telegramBotConnectionId: null,
        connectionId: null,
        desiredState: ChannelDesiredState.DISCONNECTED,
        healthStatus: ChannelHealthStatus.UNKNOWN,
        externalUserId: null,
        status: "DISCONNECTED",
        configuration: {},
      });
    }
    expect(fake.audits.at(-1)).toMatchObject({
      representativeId: "rep-1",
      payload: {
        action: "TELEGRAM_BOT_CONNECTION_REVOKED",
        affectedRepresentativeIds: ["rep-1", "rep-2"],
        referenceCount: 2,
        before: {
          status: TelegramBotConnectionStatus.ACTIVE,
          hasActiveCredential: true,
          referenceCount: 2,
        },
        after: {
          status: TelegramBotConnectionStatus.REVOKED,
          hasActiveCredential: false,
          referenceCount: 0,
        },
      },
    });

    const auditCount = fake.audits.length;
    await expect(
      revokeOwnerTelegramBotConnection(revokeInput, {
        client: fake.client as never,
      }),
    ).resolves.toMatchObject({
      changed: false,
      replayed: true,
    });
    expect(fake.audits).toHaveLength(auditCount);
    await expect(
      setOwnerTelegramBotConnectionStatus(
        {
          ownerId: "owner-1",
          actorId: "owner-1",
          telegramBotConnectionId: created.connection.id,
          status: "ACTIVE",
          requestId: "request-resume-revoked",
          idempotencyKey: "resume-revoked",
        },
        { client: fake.client as never },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("unassigns only the requested representative and retains its historical row", async () => {
    const fake = createFakeClient();
    const created = await createOrRotateOwnerTelegramBotConnection(
      {
        ownerId: "owner-1",
        actorId: "owner-1",
        token: tokenOne,
        requestId: "request-unassign-create",
        idempotencyKey: "unassign-create",
      },
      {
        client: fake.client as never,
        env: keyEnv,
        fetchImpl: getMeFetch(),
      },
    );
    const selected = addTelegramBinding(fake, {
      id: "binding-unassign-1",
      representativeId: "rep-1",
      telegramBotConnectionId: created.connection.id,
    });
    const shared = addTelegramBinding(fake, {
      id: "binding-unassign-2",
      representativeId: "rep-2",
      telegramBotConnectionId: created.connection.id,
    });
    const unassignInput = {
      ownerId: "owner-1",
      actorId: "owner-1",
      bindingId: selected.id,
      telegramBotConnectionId: created.connection.id,
      requestId: "request-unassign",
      idempotencyKey: "unassign-once",
    };

    const unassigned = await unassignOwnerTelegramBotConnection(
      unassignInput,
      { client: fake.client as never },
    );
    expect(unassigned).toMatchObject({
      changed: true,
      replayed: false,
      binding: {
        id: selected.id,
        telegramBotConnectionId: null,
        connectionId: null,
        desiredState: ChannelDesiredState.DISCONNECTED,
        status: "DISCONNECTED",
      },
    });
    expect(selected.configuration).toEqual({});
    expect(shared).toMatchObject({
      telegramBotConnectionId: created.connection.id,
      connectionId: created.connection.botId,
      desiredState: ChannelDesiredState.ACTIVE,
      status: "CONFIGURED",
    });
    expect(fake.audits.at(-1)).toMatchObject({
      representativeId: "rep-1",
      payload: {
        auditScope: "OWNER_TELEGRAM_BOT",
        action: "REPRESENTATIVE_TELEGRAM_BOT_UNASSIGNED",
        bindingId: selected.id,
        connectionId: created.connection.id,
        affectedRepresentativeIds: ["rep-1"],
        referenceCount: 1,
      },
    });

    const auditCount = fake.audits.length;
    await expect(
      unassignOwnerTelegramBotConnection(unassignInput, {
        client: fake.client as never,
      }),
    ).resolves.toMatchObject({
      changed: false,
      replayed: true,
    });
    expect(fake.audits).toHaveLength(auditCount);

    const secondConnection =
      await createOrRotateOwnerTelegramBotConnection(
        {
          ownerId: "owner-1",
          actorId: "owner-1",
          token: tokenThree,
          requestId: "request-second-unassign-bot",
          idempotencyKey: "second-unassign-bot",
        },
        {
          client: fake.client as never,
          env: keyEnv,
          fetchImpl: getMeFetch("2222222222"),
        },
      );
    await expect(
      unassignOwnerTelegramBotConnection(
        {
          ...unassignInput,
          telegramBotConnectionId: secondConnection.connection.id,
          requestId: "request-unassign-reused-payload",
        },
        { client: fake.client as never },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message:
        "Idempotency key was already used for a different Telegram Bot request on this resource.",
    });
    expect(fake.audits).toHaveLength(auditCount);

    shared.telegramBotConnectionId = secondConnection.connection.id;
    shared.connectionId = secondConnection.connection.botId;
    await expect(
      unassignOwnerTelegramBotConnection(
        {
          ...unassignInput,
          bindingId: shared.id,
          requestId: "request-stale-unassign",
          idempotencyKey: "stale-unassign",
        },
        { client: fake.client as never },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Telegram channel binding changed since it was loaded.",
    });
    expect(shared).toMatchObject({
      telegramBotConnectionId: secondConnection.connection.id,
      connectionId: secondConnection.connection.botId,
      desiredState: ChannelDesiredState.ACTIVE,
    });

    await expect(
      unassignOwnerTelegramBotConnection(
        {
          ...unassignInput,
          ownerId: "owner-2",
          actorId: "owner-2",
          bindingId: shared.id,
          idempotencyKey: "cross-owner-unassign",
        },
        { client: fake.client as never },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses an unauditable lifecycle mutation when the owner has no representative", async () => {
    const fake = createFakeClient();
    const created = await createOrRotateOwnerTelegramBotConnection(
      {
        ownerId: "owner-1",
        actorId: "owner-1",
        token: tokenOne,
        requestId: "request-no-anchor-create",
        idempotencyKey: "no-anchor-create",
      },
      {
        client: fake.client as never,
        env: keyEnv,
        fetchImpl: getMeFetch(),
      },
    );
    fake.representatives.splice(
      0,
      fake.representatives.length,
      ...fake.representatives.filter(
        (representative) => representative.ownerId !== "owner-1",
      ),
    );

    await expect(
      setOwnerTelegramBotConnectionStatus(
        {
          ownerId: "owner-1",
          actorId: "owner-1",
          telegramBotConnectionId: created.connection.id,
          status: "DISABLED",
          requestId: "request-no-anchor-disable",
          idempotencyKey: "no-anchor-disable",
        },
        { client: fake.client as never },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message:
        "Telegram Bot lifecycle changes require an owner representative for auditing.",
    });
    expect(fake.connections[0]!.status).toBe(
      TelegramBotConnectionStatus.ACTIVE,
    );
    expect(fake.audits).toHaveLength(0);
  });

  it("fails closed on getMe identity mismatch and cross-owner reuse", async () => {
    await expect(
      verifyTelegramBotToken(tokenOne, getMeFetch("9999999999")),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Telegram Bot token could not be verified.",
    });

    const fake = createFakeClient();
    await createOrRotateOwnerTelegramBotConnection(
      {
        ownerId: "owner-1",
        actorId: "owner-1",
        token: tokenOne,
        requestId: "request-owner-1",
        idempotencyKey: "owner-1-create",
      },
      {
        client: fake.client as never,
        env: keyEnv,
        fetchImpl: getMeFetch(),
      },
    );
    await expect(
      createOrRotateOwnerTelegramBotConnection(
        {
          ownerId: "owner-2",
          actorId: "owner-2",
          token: tokenOne,
          requestId: "request-owner-2",
          idempotencyKey: "owner-2-create",
        },
        {
          client: fake.client as never,
          env: keyEnv,
          fetchImpl: getMeFetch(),
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        statusCode: 409,
        message: "Telegram Bot connection is unavailable.",
      }),
    );
  });

  it.each([
    {
      state: "retired active credential",
      corrupt: (
        connection: FakeConnection,
        credential: FakeCredential,
      ) => {
        credential.status = TelegramBotCredentialStatus.RETIRED;
      },
    },
    {
      state: "revoked active credential",
      corrupt: (
        connection: FakeConnection,
        credential: FakeCredential,
      ) => {
        credential.status = TelegramBotCredentialStatus.REVOKED;
      },
    },
    {
      state: "credential revision mismatch",
      corrupt: (
        connection: FakeConnection,
        credential: FakeCredential,
      ) => {
        connection.credentialRevision = credential.version + 1;
      },
    },
    {
      state: "disabled connection",
      corrupt: (
        connection: FakeConnection,
        credential: FakeCredential,
      ) => {
        connection.status = TelegramBotConnectionStatus.DISABLED;
      },
    },
  ])(
    "fails closed instead of replaying success for a $state",
    async ({ corrupt }) => {
      const fake = createFakeClient();
      const input = {
        ownerId: "owner-1",
        actorId: "owner-1",
        token: tokenOne,
        requestId: "request-state-replay",
        idempotencyKey: "state-replay",
      };
      await createOrRotateOwnerTelegramBotConnection(input, {
        client: fake.client as never,
        env: keyEnv,
        fetchImpl: getMeFetch(),
      });
      corrupt(fake.connections[0]!, fake.credentials[0]!);

      await expect(
        createOrRotateOwnerTelegramBotConnection(input, {
          client: fake.client as never,
          env: keyEnv,
          fetchImpl: getMeFetch(),
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "Telegram Bot connection requires reconciliation.",
      });
      expect(fake.credentials).toHaveLength(1);
    },
  );

  it("idempotently activates metadata backfilled from the legacy Bot", async () => {
    const fake = createFakeClient();
    const createdAt = new Date("2026-07-27T04:00:00.000Z");
    fake.connections.push({
      id: "legacy-connection",
      ownerId: "owner-1",
      scope: TelegramBotConnectionScope.OWNER_MANAGED,
      botId: "1234567890",
      username: "legacy_bot",
      displayName: null,
      label: null,
      status: TelegramBotConnectionStatus.PENDING_CREDENTIAL,
      healthStatus: ChannelHealthStatus.UNKNOWN,
      activeCredentialId: null,
      credentialRevision: 0,
      lastVerifiedAt: null,
      lastHealthCheckAt: null,
      lastError: null,
      revokedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    const dependencies = {
      client: fake.client as never,
      env: {
        ...keyEnv,
        TELEGRAM_BOT_TOKEN: tokenOne,
      },
      fetchImpl: getMeFetch(),
      now: new Date("2026-07-27T04:05:00.000Z"),
    };

    const activated =
      await bootstrapLegacyTelegramBotConnectionFromEnv(dependencies);
    expect(activated).toMatchObject({
      id: "legacy-connection",
      status: TelegramBotConnectionStatus.ACTIVE,
      credentialRevision: 1,
    });
    expect(fake.credentials).toHaveLength(1);
    expect(
      await bootstrapLegacyTelegramBotConnectionFromEnv(dependencies),
    ).toBeNull();
    expect(fake.credentials).toHaveLength(1);
  });

  it("activates a platform-managed legacy Bot without changing its scope", async () => {
    const fake = createFakeClient();
    const createdAt = new Date("2026-07-27T03:00:00.000Z");
    fake.connections.push({
      id: "platform-legacy-connection",
      ownerId: null,
      scope: TelegramBotConnectionScope.PLATFORM_MANAGED,
      botId: "1234567890",
      username: null,
      displayName: null,
      label: "Legacy shared Bot",
      status: TelegramBotConnectionStatus.PENDING_CREDENTIAL,
      healthStatus: ChannelHealthStatus.UNKNOWN,
      activeCredentialId: null,
      credentialRevision: 0,
      lastVerifiedAt: null,
      lastHealthCheckAt: null,
      lastError: null,
      revokedAt: null,
      createdAt,
      updatedAt: createdAt,
    });

    const activated =
      await bootstrapLegacyTelegramBotConnectionFromEnv({
        client: fake.client as never,
        env: {
          ...keyEnv,
          TELEGRAM_BOT_TOKEN: tokenOne,
        },
        fetchImpl: getMeFetch(),
      });
    expect(activated).toMatchObject({
      id: "platform-legacy-connection",
      status: TelegramBotConnectionStatus.ACTIVE,
      credentialRevision: 1,
    });
    expect(fake.connections[0]).toMatchObject({
      ownerId: null,
      scope: TelegramBotConnectionScope.PLATFORM_MANAGED,
    });
    expect(JSON.stringify(activated)).not.toContain(tokenOne);
    expect(
      Buffer.from(fake.credentials[0]!.ciphertext!).toString("utf8"),
    ).not.toContain(tokenOne);
  });

  it("does not import a mismatched legacy token and fails closed without a key", async () => {
    const fake = createFakeClient();
    const createdAt = new Date("2026-07-27T02:00:00.000Z");
    fake.connections.push({
      id: "pending-legacy-connection",
      ownerId: null,
      scope: TelegramBotConnectionScope.PLATFORM_MANAGED,
      botId: "1234567890",
      username: null,
      displayName: null,
      label: null,
      status: TelegramBotConnectionStatus.PENDING_CREDENTIAL,
      healthStatus: ChannelHealthStatus.UNKNOWN,
      activeCredentialId: null,
      credentialRevision: 0,
      lastVerifiedAt: null,
      lastHealthCheckAt: null,
      lastError: null,
      revokedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    const mismatchedGetMe = getMeFetch("2222222222");
    expect(
      await bootstrapLegacyTelegramBotConnectionFromEnv({
        client: fake.client as never,
        env: {
          ...keyEnv,
          TELEGRAM_BOT_TOKEN: tokenThree,
        },
        fetchImpl: mismatchedGetMe,
      }),
    ).toBeNull();
    expect(mismatchedGetMe).not.toHaveBeenCalled();
    expect(fake.credentials).toHaveLength(0);

    await expect(
      bootstrapLegacyTelegramBotConnectionFromEnv({
        client: fake.client as never,
        env: {
          NODE_ENV: "production",
          TELEGRAM_BOT_TOKEN: tokenOne,
        },
        fetchImpl: getMeFetch(),
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      message: "Telegram Bot credential is unavailable.",
    });
    expect(fake.credentials).toHaveLength(0);
    expect(fake.connections[0]).toMatchObject({
      status: TelegramBotConnectionStatus.PENDING_CREDENTIAL,
      activeCredentialId: null,
    });
  });

  it("isolates a corrupt credential while reconciling other Bots", async () => {
    const fake = createFakeClient();
    const shared = {
      client: fake.client as never,
      env: keyEnv,
    };
    const first = await createOrRotateOwnerTelegramBotConnection(
      {
        ownerId: "owner-1",
        actorId: "owner-1",
        token: tokenOne,
        requestId: "request-first",
        idempotencyKey: "first-create",
      },
      { ...shared, fetchImpl: getMeFetch("1234567890") },
    );
    const second = await createOrRotateOwnerTelegramBotConnection(
      {
        ownerId: "owner-1",
        actorId: "owner-1",
        token: tokenThree,
        requestId: "request-second",
        idempotencyKey: "second-create",
      },
      { ...shared, fetchImpl: getMeFetch("2222222222") },
    );
    const firstCredential = fake.credentials.find(
      (credential) =>
        credential.telegramBotConnectionId === first.connection.id,
    )!;
    firstCredential.authTag = Uint8Array.from(
      Buffer.alloc(16, 255),
    );

    const configs = await listActiveTelegramBotRuntimeConfigs(shared);
    expect(configs).toEqual([
      expect.objectContaining({
        connectionId: second.connection.id,
        botId: "2222222222",
        token: tokenThree,
      }),
    ]);
    expect(
      fake.connections.find(
        (connection) => connection.id === first.connection.id,
      ),
    ).toMatchObject({
      healthStatus: ChannelHealthStatus.UNHEALTHY,
      lastError: "Telegram Bot credential is unavailable.",
    });
  });

  it("propagates sanitized runtime health without returning credentials", async () => {
    const fake = createFakeClient();
    const created = await createOrRotateOwnerTelegramBotConnection(
      {
        ownerId: "owner-1",
        actorId: "owner-1",
        token: tokenOne,
        requestId: "request-health",
        idempotencyKey: "health-create",
      },
      {
        client: fake.client as never,
        env: keyEnv,
        fetchImpl: getMeFetch(),
      },
    );
    fake.bindings.push({
      id: "binding-health",
      representativeId: "rep-1",
      kind: RepresentativeChannelKind.TELEGRAM,
      transport: ChannelTransport.TELEGRAM,
      sourceProvider: ChannelSourceProvider.TELEGRAM,
      connectionId: created.connection.botId,
      telegramBotConnectionId: created.connection.id,
      desiredState: ChannelDesiredState.ACTIVE,
      healthStatus: ChannelHealthStatus.UNKNOWN,
      externalUserId: "@delegate_test_bot",
      status: "CONFIGURED",
      configuration: { managed: true },
      lastHealthCheckAt: null,
      lastError: null,
      createdAt: new Date("2026-07-27T05:30:00.000Z"),
      updatedAt: new Date("2026-07-27T05:30:00.000Z"),
    });

    const health = await markTelegramBotRuntimeHealth(
      {
        telegramBotConnectionId: created.connection.id,
        healthStatus: "UNHEALTHY",
        lastError: `token=${tokenOne} https://api.telegram.org/private`,
        checkedAt: new Date("2026-07-27T06:00:00.000Z"),
      },
      { client: fake.client as never },
    );
    expect(health.lastError).toBe(
      "token=[redacted] [redacted-url]",
    );
    expect(fake.bindings[0]).toMatchObject({
      healthStatus: ChannelHealthStatus.UNHEALTHY,
      lastError: "token=[redacted] [redacted-url]",
    });
  });
});
