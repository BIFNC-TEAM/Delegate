import {
  generatedPrismaClientHasFields,
  preflightWeChatPayRuntime,
  prisma,
} from "@delegate/web-data";

const REQUIRED_PRISMA_FIELDS = {
  Owner: ["accountDisplayName", "accountId"],
  AudienceIdentity: ["accountId"],
  Account: ["id", "status"],
  AuthIdentity: ["accountId", "issuer", "subject"],
  AppSession: ["accountId", "authIdentityId", "application"],
  OwnerIdentityLink: ["issuer"],
  RepresentativeChannelBinding: ["endpointAssignmentRevision"],
  ConversationChannelBinding: ["representativeAssignmentRevision"],
} as const;

const REQUIRED_ACCOUNT_INDEX_NAMES = [
  "Owner_accountId_key",
  "AudienceIdentity_accountId_key",
] as const;

export async function GET() {
  const [databaseReady, weChatPay] = await Promise.all([
    checkDatabaseReadiness(),
    Promise.resolve(preflightWeChatPayRuntime()),
  ]);
  const ready = databaseReady && weChatPay.ready;
  return Response.json(
    {
      status: ready ? "ready" : "not_ready",
      service: "reps",
      databaseReady,
      weChatPay,
    },
    {
      status: ready ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

async function checkDatabaseReadiness(): Promise<boolean> {
  try {
    if (!generatedPrismaClientHasFields(REQUIRED_PRISMA_FIELDS)) {
      return false;
    }

    await prisma.$queryRaw`
      SELECT
        owner_contract."accountDisplayName",
        owner_contract."accountId",
        audience_identity_contract."accountId",
        account_contract."status",
        auth_identity_contract."accountId",
        auth_identity_contract."issuer",
        auth_identity_contract."subject",
        app_session_contract."accountId",
        app_session_contract."authIdentityId",
        app_session_contract."application",
        owner_identity_contract."issuer",
        representative_binding_contract."endpointAssignmentRevision",
        conversation_binding_contract."representativeAssignmentRevision"
      FROM "Owner" AS owner_contract
      CROSS JOIN "AudienceIdentity" AS audience_identity_contract
      CROSS JOIN "Account" AS account_contract
      CROSS JOIN "AuthIdentity" AS auth_identity_contract
      CROSS JOIN "AppSession" AS app_session_contract
      CROSS JOIN "OwnerIdentityLink" AS owner_identity_contract
      CROSS JOIN "RepresentativeChannelBinding" AS representative_binding_contract
      CROSS JOIN "ConversationChannelBinding" AS conversation_binding_contract
      LIMIT 0
    `;
    const validAccountIndexes = await prisma.$queryRaw<
      Array<{ indexName: string }>
    >`
      SELECT index_relation.relname AS "indexName"
      FROM pg_index AS index_state
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_state.indexrelid
      JOIN pg_class AS table_relation
        ON table_relation.oid = index_state.indrelid
      JOIN pg_namespace AS table_namespace
        ON table_namespace.oid = table_relation.relnamespace
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE table_namespace.nspname = current_schema()
        AND (
          (
            table_relation.relname = 'Owner'
            AND index_relation.relname = 'Owner_accountId_key'
          )
          OR (
            table_relation.relname = 'AudienceIdentity'
            AND index_relation.relname = 'AudienceIdentity_accountId_key'
          )
        )
        AND index_state.indisunique
        AND index_state.indisvalid
        AND index_state.indisready
        AND index_state.indislive
        AND index_state.indnkeyatts = 1
        AND index_state.indnatts = 1
        AND index_state.indexprs IS NULL
        AND index_state.indpred IS NULL
        AND access_method.amname = 'btree'
        AND pg_get_indexdef(index_state.indexrelid, 1, true) = '"accountId"'
    `;
    const validIndexNames = new Set(
      validAccountIndexes.map(({ indexName }) => indexName),
    );
    return REQUIRED_ACCOUNT_INDEX_NAMES.every((indexName) =>
      validIndexNames.has(indexName)
    );
  } catch {
    return false;
  }
}
