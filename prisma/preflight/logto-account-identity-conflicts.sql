-- Schema-aware, read-only review for the legacy Logto identity model before
-- and after the nullable Owner issuer expansion. BLOCKER rows must be zero.
-- REVIEW rows require an explicit mapping artifact before strict cutover.

BEGIN TRANSACTION READ ONLY;

WITH owner_logto AS (
  SELECT
    link."id" AS link_id,
    link."ownerId" AS owner_id,
    link."providerSubject" AS subject,
    CASE
      WHEN to_jsonb(link) ? 'issuer'
        THEN NULLIF(btrim(to_jsonb(link) ->> 'issuer'), '')
      ELSE NULLIF(btrim(link."metadata" ->> 'issuer'), '')
    END AS issuer,
    NULLIF(btrim(to_jsonb(link) ->> 'issuer'), '') AS stored_issuer,
    NULLIF(btrim(link."metadata" ->> 'issuer'), '') AS evidence_issuer,
    to_jsonb(link) ? 'issuer' AS issuer_column_present,
    NULLIF(lower(btrim(link."email")), '') AS normalized_email
  FROM "OwnerIdentityLink" AS link
  WHERE link."provider" = 'LOGTO'::"OwnerIdentityLinkProvider"
),
audience_logto AS (
  SELECT
    link."id" AS link_id,
    link."audienceIdentityId" AS audience_identity_id,
    link."providerSubject" AS subject,
    NULLIF(btrim(link."issuer"), '') AS issuer,
    identity."status"::text AS audience_status,
    identity."mergedIntoId" AS merged_into_id
  FROM "IdentityLink" AS link
  INNER JOIN "AudienceIdentity" AS identity
    ON identity."id" = link."audienceIdentityId"
  WHERE link."provider" = 'LOGTO'::"IdentityLinkProvider"
),
owner_issuer_required AS (
  SELECT
    'BLOCKER'::text AS severity,
    'OWNER_LOGTO_ISSUER_REQUIRED'::text AS issue_code,
    'owner_identity_link'::text AS entity_type,
    owner.link_id AS entity_key,
    jsonb_build_object(
      'ownerId', owner.owner_id,
      'subject', owner.subject,
      'issuer', owner.issuer
    ) AS details
  FROM owner_logto AS owner
  WHERE owner.issuer IS NULL
    OR owner.issuer !~ '^https?://[^[:space:]]+$'
),
owner_issuer_backfill_required AS (
  SELECT
    'BLOCKER'::text AS severity,
    'OWNER_LOGTO_ISSUER_BACKFILL_REQUIRED'::text AS issue_code,
    'owner_identity_link'::text AS entity_type,
    owner.link_id AS entity_key,
    jsonb_build_object(
      'ownerId', owner.owner_id,
      'subject', owner.subject,
      'storedIssuer', owner.stored_issuer,
      'evidenceIssuer', owner.evidence_issuer
    ) AS details
  FROM owner_logto AS owner
  WHERE owner.issuer_column_present
    AND owner.stored_issuer IS NULL
),
owner_issuer_evidence_mismatch AS (
  SELECT
    'BLOCKER'::text AS severity,
    'OWNER_LOGTO_ISSUER_EVIDENCE_MISMATCH'::text AS issue_code,
    'owner_identity_link'::text AS entity_type,
    owner.link_id AS entity_key,
    jsonb_build_object(
      'ownerId', owner.owner_id,
      'subject', owner.subject,
      'storedIssuer', owner.stored_issuer,
      'evidenceIssuer', owner.evidence_issuer
    ) AS details
  FROM owner_logto AS owner
  WHERE owner.stored_issuer IS NOT NULL
    AND owner.evidence_issuer IS NOT NULL
    AND owner.stored_issuer IS DISTINCT FROM owner.evidence_issuer
),
audience_issuer_required AS (
  SELECT
    'BLOCKER'::text AS severity,
    'AUDIENCE_LOGTO_ISSUER_REQUIRED'::text AS issue_code,
    'identity_link'::text AS entity_type,
    audience.link_id AS entity_key,
    jsonb_build_object(
      'audienceIdentityId', audience.audience_identity_id,
      'subject', audience.subject,
      'issuer', audience.issuer
    ) AS details
  FROM audience_logto AS audience
  WHERE audience.issuer IS NULL
    OR lower(audience.issuer) = 'delegate'
    OR audience.issuer !~ '^https?://[^[:space:]]+$'
),
duplicate_owner_principal AS (
  SELECT
    'BLOCKER'::text AS severity,
    'PRINCIPAL_MULTIPLE_OWNER_IDENTITIES'::text AS issue_code,
    'logto_principal'::text AS entity_type,
    owner.issuer || '|' || owner.subject AS entity_key,
    jsonb_build_object(
      'ownerIds', jsonb_agg(DISTINCT owner.owner_id ORDER BY owner.owner_id),
      'linkIds', jsonb_agg(owner.link_id ORDER BY owner.link_id)
    ) AS details
  FROM owner_logto AS owner
  WHERE owner.issuer IS NOT NULL
  GROUP BY owner.issuer, owner.subject
  HAVING count(DISTINCT owner.owner_id) > 1
),
duplicate_audience_principal AS (
  SELECT
    'BLOCKER'::text AS severity,
    'PRINCIPAL_MULTIPLE_AUDIENCE_IDENTITIES'::text AS issue_code,
    'logto_principal'::text AS entity_type,
    audience.issuer || '|' || audience.subject AS entity_key,
    jsonb_build_object(
      'audienceIdentityIds',
      jsonb_agg(
        DISTINCT audience.audience_identity_id
        ORDER BY audience.audience_identity_id
      ),
      'linkIds', jsonb_agg(audience.link_id ORDER BY audience.link_id)
    ) AS details
  FROM audience_logto AS audience
  WHERE audience.issuer IS NOT NULL
  GROUP BY audience.issuer, audience.subject
  HAVING count(DISTINCT audience.audience_identity_id) > 1
),
cross_persona_mapping AS (
  SELECT
    'REVIEW'::text AS severity,
    'CROSS_PERSONA_ACCOUNT_MAPPING_REQUIRED'::text AS issue_code,
    'logto_principal'::text AS entity_type,
    owner.issuer || '|' || owner.subject AS entity_key,
    jsonb_build_object(
      'ownerId', owner.owner_id,
      'ownerIdentityLinkId', owner.link_id,
      'audienceIdentityId', audience.audience_identity_id,
      'audienceIdentityLinkId', audience.link_id
    ) AS details
  FROM owner_logto AS owner
  INNER JOIN audience_logto AS audience
    ON audience.issuer = owner.issuer
    AND audience.subject = owner.subject
  WHERE owner.issuer IS NOT NULL
),
same_email_different_principal AS (
  SELECT
    'REVIEW'::text AS severity,
    'SAME_EMAIL_DIFFERENT_PRINCIPAL_REVIEW'::text AS issue_code,
    'normalized_email'::text AS entity_type,
    owner.normalized_email AS entity_key,
    jsonb_build_object(
      'principals',
      jsonb_agg(
        DISTINCT jsonb_build_object(
          'issuer', owner.issuer,
          'subject', owner.subject,
          'ownerId', owner.owner_id
        )
      )
    ) AS details
  FROM owner_logto AS owner
  WHERE owner.normalized_email IS NOT NULL
    AND owner.issuer IS NOT NULL
  GROUP BY owner.normalized_email
  HAVING count(DISTINCT ROW(owner.issuer, owner.subject)) > 1
),
all_known_principals AS (
  SELECT owner.issuer, owner.subject, 'owner'::text AS persona
  FROM owner_logto AS owner
  WHERE owner.issuer IS NOT NULL

  UNION ALL

  SELECT audience.issuer, audience.subject, 'audience'::text AS persona
  FROM audience_logto AS audience
  WHERE audience.issuer IS NOT NULL
),
same_subject_different_issuer AS (
  SELECT
    'REVIEW'::text AS severity,
    'SAME_SUBJECT_DIFFERENT_ISSUER_REVIEW'::text AS issue_code,
    'logto_subject'::text AS entity_type,
    principal.subject AS entity_key,
    jsonb_build_object(
      'issuers', jsonb_agg(DISTINCT principal.issuer ORDER BY principal.issuer),
      'personas', jsonb_agg(DISTINCT principal.persona ORDER BY principal.persona)
    ) AS details
  FROM all_known_principals AS principal
  GROUP BY principal.subject
  HAVING count(DISTINCT principal.issuer) > 1
),
owners_without_logto AS (
  SELECT
    'REVIEW'::text AS severity,
    'OWNER_WITHOUT_LOGTO_IDENTITY_REVIEW'::text AS issue_code,
    'owner'::text AS entity_type,
    owner."id" AS entity_key,
    jsonb_build_object(
      'displayName', owner."displayName",
      'organizationId', owner."organizationId"
    ) AS details
  FROM "Owner" AS owner
  WHERE NOT EXISTS (
    SELECT 1
    FROM owner_logto AS link
    WHERE link.owner_id = owner."id"
  )
),
non_active_audience AS (
  SELECT
    'REVIEW'::text AS severity,
    'NON_ACTIVE_AUDIENCE_IDENTITY_REVIEW'::text AS issue_code,
    'audience_identity'::text AS entity_type,
    audience.audience_identity_id AS entity_key,
    jsonb_build_object(
      'status', audience.audience_status,
      'mergedIntoId', audience.merged_into_id,
      'identityLinkId', audience.link_id,
      'issuer', audience.issuer,
      'subject', audience.subject
    ) AS details
  FROM audience_logto AS audience
  WHERE audience.audience_status IN ('MERGED', 'DISABLED')
),
organization_owner_edges AS (
  SELECT
    owner."organizationId" AS organization_id,
    owner."id" AS owner_id,
    'owner.organizationId'::text AS source
  FROM "Owner" AS owner
  WHERE owner."organizationId" IS NOT NULL

  UNION ALL

  SELECT
    member."organizationId" AS organization_id,
    member."ownerId" AS owner_id,
    'organizationMember'::text AS source
  FROM "OrganizationMember" AS member
),
organization_membership_mismatch AS (
  SELECT
    'BLOCKER'::text AS severity,
    'OWNER_ORGANIZATION_MEMBERSHIP_MISMATCH'::text AS issue_code,
    'owner'::text AS entity_type,
    owner."id" AS entity_key,
    jsonb_build_object(
      'ownerOrganizationId', owner."organizationId",
      'membershipOrganizationId', member."organizationId",
      'organizationMemberId', member."id"
    ) AS details
  FROM "Owner" AS owner
  LEFT JOIN "OrganizationMember" AS member
    ON member."ownerId" = owner."id"
  WHERE owner."organizationId" IS DISTINCT FROM member."organizationId"
    AND (
      owner."organizationId" IS NOT NULL
      OR member."organizationId" IS NOT NULL
    )
),
multi_owner_organization AS (
  SELECT
    'REVIEW'::text AS severity,
    'MULTI_OWNER_ORGANIZATION_MAPPING_REQUIRED'::text AS issue_code,
    'organization'::text AS entity_type,
    organization."id" AS entity_key,
    jsonb_build_object(
      'slug', organization."slug",
      'ownerIds',
      jsonb_agg(
        DISTINCT edge.owner_id
        ORDER BY edge.owner_id
      ),
      'ownerCount', count(DISTINCT edge.owner_id),
      'sources', jsonb_agg(DISTINCT edge.source ORDER BY edge.source)
    ) AS details
  FROM "Organization" AS organization
  INNER JOIN organization_owner_edges AS edge
    ON edge.organization_id = organization."id"
  GROUP BY organization."id", organization."slug"
  HAVING count(DISTINCT edge.owner_id) > 1
)
SELECT
  issue.severity,
  issue.issue_code,
  issue.entity_type,
  issue.entity_key,
  issue.details
FROM (
  SELECT * FROM owner_issuer_required
  UNION ALL
  SELECT * FROM owner_issuer_backfill_required
  UNION ALL
  SELECT * FROM owner_issuer_evidence_mismatch
  UNION ALL
  SELECT * FROM audience_issuer_required
  UNION ALL
  SELECT * FROM duplicate_owner_principal
  UNION ALL
  SELECT * FROM duplicate_audience_principal
  UNION ALL
  SELECT * FROM cross_persona_mapping
  UNION ALL
  SELECT * FROM same_email_different_principal
  UNION ALL
  SELECT * FROM same_subject_different_issuer
  UNION ALL
  SELECT * FROM owners_without_logto
  UNION ALL
  SELECT * FROM non_active_audience
  UNION ALL
  SELECT * FROM organization_membership_mismatch
  UNION ALL
  SELECT * FROM multi_owner_organization
) AS issue
ORDER BY
  CASE issue.severity WHEN 'BLOCKER' THEN 0 ELSE 1 END,
  issue.issue_code,
  issue.entity_type,
  issue.entity_key;

COMMIT;
