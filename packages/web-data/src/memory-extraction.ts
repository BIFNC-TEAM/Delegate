import { createHash, randomUUID } from "node:crypto";

import {
  AudienceIdentityStatus,
  ContactMemorySharingConsentStatus,
  ContactMemorySharingSourceEventRole,
  GovernedMemoryStatus,
  IdentityAssuranceLevel,
  IdentityLinkProvider,
  MemoryCandidateStatus,
  MemoryCategory,
  MemoryExtractionStatus,
  MemoryExtractionTrigger,
  MemoryProjectionStatus,
  MemoryPolicyDecisionOutcome,
  MemorySafetyClass,
  MemoryScope,
  MemorySourceKind,
  MessageContentType,
  MessageSenderType,
  Prisma,
  RepresentativeChannelKind,
  type RepresentativeMemoryPolicy,
} from "@prisma/client";

import {
  applyAutomaticMemoryPolicyInTransaction,
  lockContactSharedMemoryCoordinate,
  recordAutomaticMarkerPolicyDecisionInTransaction,
  recordRepresentativeEvidencePolicyDecisionInTransaction,
  requestAutomaticContactChannelMemoryDeletionInTransaction,
  requestAutomaticContactReplyPreferenceDeletionInTransaction,
} from "./memory-governance";
import {
  lockAndResolveExactMessageIdentityEvidence,
  type ExactMessageIdentityEvidence,
} from "./contact-memory-source-evidence";
import {
  contactMemorySharingConsentContractVersion,
  hasCurrentMemoryChannelDisclosureForMessage,
} from "./memory-disclosure";
import {
  contactChannelMemoryForgetCutoffReasonCode,
  currentContactChannelMemoryEpoch,
  isContactChannelMemorySourceAfterForgetBoundary,
  loadLatestContactChannelMemoryForgetBoundary,
  lockContactChannelMemoryCoordinate,
  toRepresentativeMemoryChannel,
} from "./memory-forget-boundary";
import { prisma } from "./prisma";
import { runWithPrismaWriteConflictRetry } from "./prisma-write-conflict-retry";

export type MemoryExtractionChannel = "web" | "matrix" | "telegram";

type MemoryExtractionPolicySnapshot = Pick<
  RepresentativeMemoryPolicy,
  | "longTermMemoryEnabled"
  | "contactMemoryEnabled"
  | "contactMemoryCrossChannelEnabled"
  | "representativeExperienceEnabled"
  | "autoExtract"
  | "webExtractEnabled"
  | "matrixExtractEnabled"
  | "telegramExtractEnabled"
  | "retentionDays"
  | "revision"
>;

export type MemoryExtractionPolicyGate =
  | { allowed: true }
  | {
      allowed: false;
      reasonCode:
        | "memory_policy_missing"
        | "long_term_memory_disabled"
        | "contact_memory_disabled"
        | "representative_experience_disabled"
        | "automatic_extraction_disabled"
        | "memory_channel_disclosure_unavailable"
        | "memory_channel_disclosure_missing"
        | "memory_extraction_trigger_retired"
        | "channel_extraction_disabled"
        | "channel_trigger_contact_scope_only";
    };

type MemoryExtractionPolicyRejectionReason = Extract<
  MemoryExtractionPolicyGate,
  { allowed: false }
>["reasonCode"];

export type MemoryCandidateClassification =
  | {
      kind: "none";
      reasonCode: "no_allowlisted_structured_fact";
    }
  | {
      kind: "reviewable";
      category: MemoryCategory;
      extractionReasonCode:
        | "explicit_contact_preference"
        | "explicit_contact_goal"
        | "explicit_contact_constraint"
        | "deidentified_response_pattern"
        | "deidentified_service_pattern"
        | "deidentified_safety_pattern";
      safeText: string;
      summary: string;
      safetyClass: typeof MemorySafetyClass.LOW_RISK;
      deidentified: boolean;
    }
  | {
      kind: "marker";
      category: MemoryCategory;
      status:
        | typeof MemoryCandidateStatus.BLOCKED
        | typeof MemoryCandidateStatus.QUARANTINED;
      safetyClass:
        | typeof MemorySafetyClass.PROHIBITED
        | typeof MemorySafetyClass.SENSITIVE;
      safetyReasonCode:
        | "source_owner_private_note"
        | "source_tool_output"
        | "source_compute_output"
        | "source_non_audience_message"
        | "source_non_text_message"
        | "credential_material_detected"
        | "transaction_or_entitlement_fact_detected"
        | "persistent_prompt_injection_detected"
        | "personally_identifying_information_detected"
        | "health_or_disability_information_detected"
        | "religious_belief_detected"
        | "race_or_ethnicity_detected"
        | "political_affiliation_detected"
        | "sexual_orientation_or_gender_identity_detected"
        | "biometric_identifier_detected"
        | "trade_union_membership_detected"
        | "commercial_secret_detected"
        | "unbounded_structured_fact_detected"
        | "safety_classification_failed";
    };

export type MemoryCandidateClassifier = (
  input: Parameters<typeof classifyMemoryCandidate>[0],
) => MemoryCandidateClassification;

export type EnqueueMemoryExtractionResult =
  | {
      enqueued: true;
      replayed: boolean;
      runId: string;
      idempotencyKey: string;
    }
  | {
      enqueued: false;
      reasonCode:
        | "memory_storage_unavailable"
        | MemoryExtractionPolicyRejectionReason
        | "memory_source_not_found"
        | "memory_source_coordinates_mismatch"
        | "memory_source_channel_missing"
        | "memory_source_channel_mismatch"
        | "memory_source_not_audience_message"
        | "memory_source_not_text"
        | "memory_source_edited"
        | "memory_source_redacted"
        | typeof contactChannelMemoryForgetCutoffReasonCode
        | "representative_experience_trigger_not_allowed";
    };

export type InboundMemoryExtractionInput = {
  representativeId: string;
  contactId: string;
  conversationId: string;
  messageId: string;
  channel: MemoryExtractionChannel;
};

export type MemoryExtractionWorkClaim = {
  runId: string;
  leaseToken: string;
  attemptCount: number;
};

export type MemoryExtractionWorkResult =
  | { processed: false }
  | {
      processed: true;
      runId: string;
      status: "completed" | "canceled" | "retrying" | "failed" | "lease_lost";
      attemptCount: number;
      errorCode?: string;
      availableAt?: Date;
    };

type MemoryExtractionSource = {
  id: string;
  conversationId: string;
  channelBindingId: string | null;
  channelLifecycleRevision: number | null;
  createdAt: Date;
  ingressSequence: number | null;
  memoryIngressOrdinal: bigint | null;
  senderType: MessageSenderType;
  contentType: MessageContentType;
  text: string | null;
  editedAt: Date | null;
  redactedAt: Date | null;
  conversation: {
    representativeId: string;
    contactId: string;
    sourceChannel: string | null;
  };
};

type MemoryExtractionRunWithSource = {
  id: string;
  representativeId: string;
  contactId: string | null;
  sourceChannel: RepresentativeChannelKind;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  trigger: MemoryExtractionTrigger;
  status: MemoryExtractionStatus;
  idempotencyKey: string;
  contactChannelMemoryEpoch: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  sourceMessage: MemoryExtractionSource | null;
};

type PrivateChannelExtractionEpochErrorCode =
  | "matrix_memory_extraction_source_lifecycle_missing"
  | "matrix_memory_extraction_channel_lifecycle_changed"
  | "matrix_memory_extraction_channel_assignment_missing"
  | "matrix_memory_extraction_channel_assignment_changed"
  | "matrix_memory_extraction_channel_identity_changed"
  | "matrix_memory_extraction_channel_not_active"
  | "telegram_memory_extraction_channel_assignment_missing"
  | "telegram_memory_extraction_channel_assignment_changed"
  | "telegram_memory_extraction_channel_identity_changed"
  | "telegram_memory_extraction_channel_not_active";

const extractionContractVersion = "v2";
const compatibleExtractionContractVersions = new Set(["v1", "v2"]);
const extractionLeaseMilliseconds = 60_000;
const maximumExtractionAttempts = 5;
const extractionRetryBaseMilliseconds = 1_000;
const extractionRetryMaximumMilliseconds = 60_000;

const promptInjectionPattern =
  /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions?|prompts?)|(?:reveal|show|print)\s+(?:the\s+)?system\s+prompt|(?:remember|store)\s+this\s+(?:instruction|prompt)\s+(?:forever|permanently)|忽略(?:之前|以上|所有|系统|开发者)(?:的)?(?:指令|提示)|(?:泄露|显示|打印)(?:系统)?提示词|(?:永久|永远)(?:记住|保存)(?:这条|这个)(?:指令|提示)/iu;
const credentialPattern =
  /(?:password|passwd|passcode|api[\s_-]*key|client[\s_-]*secret|access[\s_-]*token|refresh[\s_-]*token|bearer\s+[a-z0-9._~-]+|private[\s_-]*key|seed\s+phrase|mnemonic|one[\s_-]*time\s+code|otp|set-cookie|session[\s_-]*cookie|cookie\s*:|密码|口令|验证码|密钥|私钥|助记词|访问令牌|刷新令牌|会话\s*cookie)/iu;
const bareCredentialPattern =
  /(?:-----BEGIN(?:\s+[A-Z]+)*\s+PRIVATE KEY-----|\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b|\bsk-[a-zA-Z0-9_-]{16,}\b|\bgh[pousr]_[a-zA-Z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b)/u;
const transactionPattern =
  /(?:payment|paid|price|amount|balance|wallet|refund|invoice|entitlement|credit(?:s)?|subscription|付款|支付|金额|余额|钱包|退款|发票|权益|授权|订阅|价格|价款|额度)/iu;
const currencyAmountPattern =
  /(?:[$€£¥￥]\s*\d|\b\d+(?:\.\d{1,2})?\s*(?:usd|eur|gbp|cny|rmb)\b|\d+(?:\.\d{1,2})?\s*(?:元|块|美元|欧元|英镑))/iu;
const emailPattern = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/iu;
const phonePattern = /(?:\+?\d[\d\s().-]{7,}\d)/u;
const governmentIdPattern =
  /(?:social\s+security|ssn|passport|national\s+id|identity\s+card|身份证|护照|社保号|银行卡|银行账户|bank\s+account)/iu;
const explicitIdentityFieldPattern =
  /(?:\b(?:my\s+name|(?:my\s+)?(?:full|legal)\s+name)\s*(?:is|:)|\b(?:my\s+)?(?:date\s+of\s+birth|birthday|home\s+address|mailing\s+address|shipping\s+address)\s*(?:is|:)|(?:我的?)?(?:姓名|全名|真实姓名|法定姓名|出生日期|出生年月|生日|家庭地址|邮寄地址|收货地址|住址)\s*(?:是|为|[:：]))/iu;
const healthOrDisabilityPattern =
  /(?:\b(?:my\s+)?(?:diagnosis|medical\s+(?:history|record)|health\s+condition|disability\s+status)\s*(?:is|:)|\bi\s+(?:have\s+been|was)\s+diagnosed\s+with\b|\bi\s+(?:have|suffer\s+from|live\s+with)\s+(?:diabetes|cancer|hiv|aids|autism|epilepsy|depression|bipolar\s+disorder|multiple\s+sclerosis)\b|\bi\s+am\s+(?:disabled|deaf|blind)\b|(?:我的?)?(?:诊断|病历|病史|健康状况|残疾情况|残障情况)\s*(?:是|为|[:：])|我(?:患有|被诊断为|被确诊为)|我是(?:残疾人|残障人士|聋人|盲人))/iu;
const religiousBeliefPattern =
  /(?:\b(?:my\s+)?(?:religion|religious\s+belief|faith)\s*(?:is|:)|\bi\s+am\s+(?:a\s+)?(?:christian|muslim|jewish|hindu|buddhist|sikh|atheist)\b|(?:我的?)?(?:宗教|宗教信仰|信仰)\s*(?:是|为|[:：])|我是(?:基督徒|穆斯林|犹太教徒|印度教徒|佛教徒|锡克教徒|无神论者))/iu;
const raceOrEthnicityPattern =
  /(?:\b(?:my\s+)?(?:race|ethnicity|ethnic\s+background)\s*(?:is|:)|\bi\s+am\s+(?:asian|black|white|latino|latina|hispanic|indigenous|native\s+american)\b|(?:我的?)?(?:种族|民族|族裔|民族成分)\s*(?:是|为|[:：])|我是(?:汉族|藏族|维吾尔族|回族|蒙古族|苗族|壮族))/iu;
const politicalAffiliationPattern =
  /(?:\b(?:my\s+)?(?:political\s+(?:view|views|opinion|opinions|affiliation)|party\s+affiliation)\s*(?:is|are|:)|\bi\s+am\s+(?:a\s+)?member\s+of\s+(?:the\s+)?[a-z][a-z\s-]*\s+party\b|(?:我的?)?(?:政治观点|政治立场|党派|党派归属)\s*(?:是|为|[:：])|我是(?:中共党员|共产党员|民主党党员|共和党党员)|我加入了.{0,20}党)/iu;
const sexualOrientationOrGenderIdentityPattern =
  /(?:\b(?:my\s+)?(?:sexual\s+orientation|gender\s+identity)\s*(?:is|:)|\bi\s+(?:identify\s+as|am)\s+(?:gay|lesbian|bisexual|transgender|nonbinary|non-binary|queer)\b|(?:我的?)?(?:性取向|性倾向|性别认同|性别身份)\s*(?:是|为|[:：])|我是(?:同性恋|双性恋|跨性别|非二元性别|酷儿))/iu;
const biometricIdentifierPattern =
  /(?:\b(?:my\s+)?(?:fingerprint|faceprint|facial\s+template|iris\s+scan|retina\s+scan|voiceprint|voice\s+print|dna\s+profile)\s*(?:is|:)|(?:我的?)?(?:指纹|人脸模板|面部模板|虹膜|视网膜|声纹|DNA信息|DNA档案)\s*(?:是|为|[:：]))/iu;
const tradeUnionMembershipPattern =
  /(?:\b(?:my\s+)?(?:trade\s+union|labor\s+union|union)\s+membership\s*(?:is|:)|\bi\s+am\s+(?:a\s+)?(?:trade\s+union|labor\s+union|union)\s+member\b|(?:我的?)?(?:工会会员身份|工会归属|工会成员身份)\s*(?:是|为|[:：])|我是.{0,20}工会(?:的)?会员)/iu;
const commercialSecretPattern =
  /(?:trade\s+secret|commercial\s+secret|confidential|strictly\s+internal|under\s+nda|proprietary|商业机密|商业秘密|保密信息|严格保密|仅限内部|内部机密|未公开策略)/iu;
const markerSafetyReasonCodes = new Set<string>([
  "source_owner_private_note",
  "source_tool_output",
  "source_compute_output",
  "source_non_audience_message",
  "source_non_text_message",
  "credential_material_detected",
  "transaction_or_entitlement_fact_detected",
  "persistent_prompt_injection_detected",
  "personally_identifying_information_detected",
  "health_or_disability_information_detected",
  "religious_belief_detected",
  "race_or_ethnicity_detected",
  "political_affiliation_detected",
  "sexual_orientation_or_gender_identity_detected",
  "biometric_identifier_detected",
  "trade_union_membership_detected",
  "commercial_secret_detected",
  "unbounded_structured_fact_detected",
  "safety_classification_failed",
]);
const reviewableExtractionReasonCodes = new Set<string>([
  "explicit_contact_preference",
  "deidentified_response_pattern",
]);

/**
 * P0 extraction is intentionally a closed vocabulary. A denylist cannot
 * prove that arbitrary free text is safe, so only canonical communication
 * preferences may become reviewable candidates. Goals, constraints, and
 * unrecognised preference prose stay bodyless in quarantine.
 */
const closedCommunicationPreferences = new Map<string, string>([
  ["i prefer concise replies", "Preference: reply_length=concise"],
  ["i prefer brief replies", "Preference: reply_length=concise"],
  ["i prefer short replies", "Preference: reply_length=concise"],
  ["i prefer detailed replies", "Preference: reply_length=detailed"],
  ["i prefer thorough replies", "Preference: reply_length=detailed"],
  ["i prefer replies in chinese", "Preference: reply_language=zh"],
  ["i prefer chinese replies", "Preference: reply_language=zh"],
  ["i prefer replies in english", "Preference: reply_language=en"],
  ["i prefer english replies", "Preference: reply_language=en"],
  ["i prefer concise chinese replies", "Preference: reply_length=concise; reply_language=zh"],
  ["i prefer concise english replies", "Preference: reply_length=concise; reply_language=en"],
  ["i prefer bullet point replies", "Preference: reply_format=bullets"],
  ["i prefer bullet-point replies", "Preference: reply_format=bullets"],
  ["i prefer numbered list replies", "Preference: reply_format=numbered_list"],
  ["i prefer step-by-step replies", "Preference: reply_format=steps"],
  ["i prefer markdown replies", "Preference: reply_format=markdown"],
  ["i prefer plain text replies", "Preference: reply_format=plain_text"],
  ["i prefer formal replies", "Preference: reply_tone=formal"],
  ["i prefer friendly replies", "Preference: reply_tone=friendly"],
  ["i prefer direct replies", "Preference: reply_tone=direct"],
  ["i prefer casual replies", "Preference: reply_tone=casual"],
  ["我偏好简短回答", "Preference: reply_length=concise"],
  ["我偏好简洁回答", "Preference: reply_length=concise"],
  ["我偏好详细回答", "Preference: reply_length=detailed"],
  ["我偏好详尽回答", "Preference: reply_length=detailed"],
  ["我偏好中文回答", "Preference: reply_language=zh"],
  ["我偏好英文回答", "Preference: reply_language=en"],
  ["我偏好简短的中文回答", "Preference: reply_length=concise; reply_language=zh"],
  ["我偏好简短的英文回答", "Preference: reply_length=concise; reply_language=en"],
  ["我偏好要点回答", "Preference: reply_format=bullets"],
  ["我偏好编号列表回答", "Preference: reply_format=numbered_list"],
  ["我偏好分步骤回答", "Preference: reply_format=steps"],
  ["我偏好 markdown 回答", "Preference: reply_format=markdown"],
  ["我偏好纯文本回答", "Preference: reply_format=plain_text"],
  ["我偏好正式回答", "Preference: reply_tone=formal"],
  ["我偏好友好回答", "Preference: reply_tone=friendly"],
  ["我偏好直接回答", "Preference: reply_tone=direct"],
  ["我偏好轻松回答", "Preference: reply_tone=casual"],
]);
const closedCommunicationPreferenceValues = new Set(
  closedCommunicationPreferences.values(),
);
const deterministicContactForgetCommands = new Set([
  "forget my reply preference",
  "忘记我的回复偏好",
]);
const deterministicContactMemoryDeleteCommands = new Set([
  "/delete_memory",
  "/forget",
  "delete my memory",
  "forget my memory",
  "删除我的记忆",
]);
const representativeResponseSafeText =
  "Response pattern: adapt the reply format to an explicitly stated communication preference.";
const representativeResponseSummary =
  "Adapt response format to an explicit communication preference.";
const structuredFactTriggerPattern =
  /(?:我的目标是|我的目标为|我计划|我打算|我不能|我无法|我不方便|我需要避免|我只能|我的限制是|我更喜欢|我喜欢|我偏好|我希望你|\bmy\s+goal\s+is\b|\bi\s+(?:plan|aim|intend)\s+to\b|\bi\s+(?:cannot|can't|am\s+unable\s+to|need\s+to\s+avoid|am\s+only\s+available|must\s+not)\b|\bi\s+(?:prefer|like|would\s+like\s+you\s+to|want\s+you\s+to)\b)/iu;

export function resolveMemoryExtractionPolicyGate(
  policy: MemoryExtractionPolicySnapshot | null | undefined,
  channel: MemoryExtractionChannel,
  trigger: MemoryExtractionTrigger,
  scope: MemoryScope,
): MemoryExtractionPolicyGate {
  if (!policy) return { allowed: false, reasonCode: "memory_policy_missing" };
  if (!policy.longTermMemoryEnabled) {
    return { allowed: false, reasonCode: "long_term_memory_disabled" };
  }
  if (trigger !== MemoryExtractionTrigger.CHANNEL_MESSAGE) {
    return { allowed: false, reasonCode: "memory_extraction_trigger_retired" };
  }
  const representativeOnlyAutomaticRun =
    scope === MemoryScope.CONTACT_CHANNEL
    && policy.representativeExperienceEnabled;
  if (
    scope === MemoryScope.CONTACT_CHANNEL
    && !policy.contactMemoryEnabled
    && !representativeOnlyAutomaticRun
  ) {
    return { allowed: false, reasonCode: "contact_memory_disabled" };
  }
  if (
    scope === MemoryScope.REPRESENTATIVE
    && !policy.representativeExperienceEnabled
  ) {
    return {
      allowed: false,
      reasonCode: "representative_experience_disabled",
    };
  }
  if (scope !== MemoryScope.CONTACT_CHANNEL) {
    return { allowed: false, reasonCode: "channel_trigger_contact_scope_only" };
  }
  if (!policy.autoExtract) {
    return { allowed: false, reasonCode: "automatic_extraction_disabled" };
  }
  const channelExtractEnabled = channel === "web"
    ? policy.webExtractEnabled
    : channel === "matrix"
      ? policy.matrixExtractEnabled
      : policy.telegramExtractEnabled;
  return channelExtractEnabled
    ? { allowed: true }
    : { allowed: false, reasonCode: "channel_extraction_disabled" };
}

export type ContactMemorySharingEligibility =
  | { eligible: true; audienceIdentityId: string }
  | {
      eligible: false;
      reasonCode:
        | "cross_channel_sharing_disabled"
        | "contact_identity_missing"
        | "contact_identity_not_registered"
        | "verified_identity_link_missing"
        | "sharing_consent_missing"
        | "sharing_consent_revoked"
        | "sharing_consent_stale";
    };

/**
 * Cross-channel contact memory is a separate, explicit promotion decision.
 * The default extraction remains CONTACT_CHANNEL; only a canonical verified
 * identity with a current explicit consent proof may be promoted.
 */
export async function resolveContactMemorySharingEligibility(
  tx: Prisma.TransactionClient,
  input: {
    representativeId: string;
    contactId: string;
    policy?: Pick<
      RepresentativeMemoryPolicy,
      "contactMemoryCrossChannelEnabled" | "revision"
    > | null;
    sourceChannel: RepresentativeChannelKind;
    sourceEvidence: ExactMessageIdentityEvidence | null;
  },
): Promise<ContactMemorySharingEligibility> {
  const policy = input.policy ?? await tx.representativeMemoryPolicy.findUnique({
    where: { representativeId: input.representativeId },
    select: {
      contactMemoryCrossChannelEnabled: true,
      revision: true,
    },
  });
  if (!policy?.contactMemoryCrossChannelEnabled) {
    return { eligible: false, reasonCode: "cross_channel_sharing_disabled" };
  }
  const contact = await tx.contact.findFirst({
    where: {
      id: input.contactId,
      representativeId: input.representativeId,
    },
    select: { audienceIdentityId: true },
  });
  if (!contact?.audienceIdentityId) {
    return { eligible: false, reasonCode: "contact_identity_missing" };
  }
  const visited = new Set<string>();
  let identityId = contact.audienceIdentityId;
  let identity: {
    id: string;
    status: AudienceIdentityStatus;
    mergedIntoId: string | null;
  } | null = null;
  for (let depth = 0; depth < 32; depth += 1) {
    if (visited.has(identityId)) {
      return {
        eligible: false,
        reasonCode: "contact_identity_not_registered",
      };
    }
    visited.add(identityId);
    identity = await tx.audienceIdentity.findUnique({
      where: { id: identityId },
      select: {
        id: true,
        status: true,
        mergedIntoId: true,
      },
    });
    if (!identity) {
      return { eligible: false, reasonCode: "contact_identity_missing" };
    }
    if (
      identity.status === AudienceIdentityStatus.MERGED
      && identity.mergedIntoId
    ) {
      identityId = identity.mergedIntoId;
      continue;
    }
    break;
  }
  if (
    !identity
    || identity.status !== AudienceIdentityStatus.REGISTERED
    || identity.mergedIntoId
  ) {
    return {
      eligible: false,
      reasonCode: "contact_identity_not_registered",
    };
  }
  if (
    !input.sourceEvidence
    || input.sourceEvidence.sourceChannel !== input.sourceChannel
    || input.sourceEvidence.canonicalAudienceIdentityId !== identity.id
  ) {
    return { eligible: false, reasonCode: "verified_identity_link_missing" };
  }
  const consent = await tx.contactMemorySharingConsent.findFirst({
    where: {
      representativeId: input.representativeId,
      audienceIdentityId: identity.id,
      policyRevision: policy.revision,
    },
    orderBy: { consentVersion: "desc" },
    select: {
      id: true,
      status: true,
      grantedAt: true,
      revokedAt: true,
      policyRevision: true,
      consentVersion: true,
      disclosureContractVersion: true,
      proofHash: true,
      challengeId: true,
      sourceEvidenceHash: true,
      confirmationEventHash: true,
      sourceEventClaim: {
        select: {
          eventHash: true,
          role: true,
          representativeId: true,
          audienceIdentityId: true,
          sourceChannel: true,
          challengeId: true,
          consentId: true,
        },
      },
      challenge: {
        select: {
          id: true,
          audienceIdentityId: true,
          representativeId: true,
          sourceChannel: true,
          policyRevision: true,
          disclosureContractVersion: true,
          sourceEvidenceHash: true,
          disclosureEventHash: true,
          createdAt: true,
          expiresAt: true,
          consumedAt: true,
          revokedAt: true,
          sourceEventClaims: {
            where: {
              role: ContactMemorySharingSourceEventRole.DISCLOSURE,
            },
            select: {
              eventHash: true,
              role: true,
              representativeId: true,
              audienceIdentityId: true,
              sourceChannel: true,
              challengeId: true,
              consentId: true,
            },
          },
        },
      },
    },
  });
  if (!consent) {
    return { eligible: false, reasonCode: "sharing_consent_missing" };
  }
  if (
    consent.status !== ContactMemorySharingConsentStatus.GRANTED
    || !consent.grantedAt
    || consent.revokedAt
  ) {
    return { eligible: false, reasonCode: "sharing_consent_revoked" };
  }
  if (
    consent.consentVersion < 1
    || consent.disclosureContractVersion
      !== contactMemorySharingConsentContractVersion
    || !/^[0-9a-f]{64}$/u.test(consent.proofHash)
    || !consent.challengeId
    || !/^[0-9a-f]{64}$/u.test(consent.sourceEvidenceHash ?? "")
    || !/^[0-9a-f]{64}$/u.test(consent.confirmationEventHash ?? "")
    || !consent.challenge
    || consent.challenge.representativeId !== input.representativeId
    || consent.challenge.audienceIdentityId !== identity.id
    || consent.challenge.policyRevision !== policy.revision
    || consent.challenge.disclosureContractVersion
      !== contactMemorySharingConsentContractVersion
    || consent.challenge.sourceEvidenceHash !== consent.sourceEvidenceHash
    || !consent.challenge.consumedAt
    || consent.challenge.consumedAt < consent.challenge.createdAt
    || consent.challenge.consumedAt > consent.challenge.expiresAt
    || consent.grantedAt < consent.challenge.consumedAt
    || consent.challenge.revokedAt
    || !Array.isArray(consent.challenge.sourceEventClaims)
    || !consent.challenge.sourceEventClaims.some((claim) =>
      claim.eventHash === consent.challenge?.disclosureEventHash
      && claim.role === ContactMemorySharingSourceEventRole.DISCLOSURE
      && claim.representativeId === input.representativeId
      && claim.audienceIdentityId === identity.id
      && claim.sourceChannel === consent.challenge?.sourceChannel
      && claim.challengeId === consent.challengeId
      && claim.consentId === null
    )
    || consent.sourceEventClaim?.eventHash !== consent.confirmationEventHash
    || consent.sourceEventClaim.role
      !== ContactMemorySharingSourceEventRole.CONFIRMATION
    || consent.sourceEventClaim.representativeId !== input.representativeId
    || consent.sourceEventClaim.audienceIdentityId !== identity.id
    || consent.sourceEventClaim.sourceChannel !== consent.challenge.sourceChannel
    || consent.sourceEventClaim.challengeId !== consent.challengeId
    || consent.sourceEventClaim.consentId !== consent.id
  ) {
    return { eligible: false, reasonCode: "sharing_consent_stale" };
  }
  return { eligible: true, audienceIdentityId: identity.id };
}

export function classifyMemoryCandidate(input: {
  text: string | null;
  senderType: MessageSenderType;
  contentType: MessageContentType;
  scope: MemoryScope;
}): MemoryCandidateClassification {
  const markerCategory = input.scope === MemoryScope.REPRESENTATIVE
    ? MemoryCategory.REPRESENTATIVE_SAFETY_PATTERN
    : MemoryCategory.CONTACT_CONTEXT;
  if (input.senderType !== MessageSenderType.AUDIENCE) {
    const safetyReasonCode =
      input.senderType === MessageSenderType.OPERATOR
        ? "source_owner_private_note"
        : input.senderType === MessageSenderType.TOOL
          ? "source_tool_output"
          : input.senderType === MessageSenderType.SYSTEM
            ? "source_compute_output"
            : "source_non_audience_message";
    return prohibitedMarker(markerCategory, safetyReasonCode);
  }
  if (input.contentType !== MessageContentType.TEXT || !input.text?.trim()) {
    return prohibitedMarker(markerCategory, "source_non_text_message");
  }

  const normalized = normalizeCandidateText(input.text);
  if (promptInjectionPattern.test(normalized)) {
    return prohibitedMarker(
      markerCategory,
      "persistent_prompt_injection_detected",
    );
  }
  if (credentialPattern.test(normalized) || bareCredentialPattern.test(normalized)) {
    return prohibitedMarker(markerCategory, "credential_material_detected");
  }
  if (transactionPattern.test(normalized) || currencyAmountPattern.test(normalized)) {
    return prohibitedMarker(
      markerCategory,
      "transaction_or_entitlement_fact_detected",
    );
  }
  if (
    emailPattern.test(normalized)
    || phonePattern.test(normalized)
    || governmentIdPattern.test(normalized)
    || explicitIdentityFieldPattern.test(normalized)
  ) {
    return sensitiveMarker(
      markerCategory,
      "personally_identifying_information_detected",
    );
  }
  if (healthOrDisabilityPattern.test(normalized)) {
    return sensitiveMarker(
      markerCategory,
      "health_or_disability_information_detected",
    );
  }
  if (religiousBeliefPattern.test(normalized)) {
    return sensitiveMarker(markerCategory, "religious_belief_detected");
  }
  if (raceOrEthnicityPattern.test(normalized)) {
    return sensitiveMarker(markerCategory, "race_or_ethnicity_detected");
  }
  if (politicalAffiliationPattern.test(normalized)) {
    return sensitiveMarker(markerCategory, "political_affiliation_detected");
  }
  if (sexualOrientationOrGenderIdentityPattern.test(normalized)) {
    return sensitiveMarker(
      markerCategory,
      "sexual_orientation_or_gender_identity_detected",
    );
  }
  if (biometricIdentifierPattern.test(normalized)) {
    return sensitiveMarker(markerCategory, "biometric_identifier_detected");
  }
  if (tradeUnionMembershipPattern.test(normalized)) {
    return sensitiveMarker(markerCategory, "trade_union_membership_detected");
  }
  if (commercialSecretPattern.test(normalized)) {
    return sensitiveMarker(markerCategory, "commercial_secret_detected");
  }

  const safeText = closedCommunicationPreferences.get(
    normalizeClosedPreferenceKey(normalized),
  );
  if (!safeText) {
    return structuredFactTriggerPattern.test(normalized)
      ? sensitiveMarker(markerCategory, "unbounded_structured_fact_detected")
      : { kind: "none", reasonCode: "no_allowlisted_structured_fact" };
  }
  if (input.scope === MemoryScope.REPRESENTATIVE) {
    return {
      kind: "reviewable",
      category: MemoryCategory.REPRESENTATIVE_RESPONSE_PATTERN,
      extractionReasonCode: "deidentified_response_pattern",
      safeText: representativeResponseSafeText,
      summary: representativeResponseSummary,
      safetyClass: MemorySafetyClass.LOW_RISK,
      deidentified: true,
    };
  }

  return {
    kind: "reviewable",
    category: MemoryCategory.CONTACT_PREFERENCE,
    extractionReasonCode: "explicit_contact_preference",
    safeText,
    summary: safeText,
    safetyClass: MemorySafetyClass.LOW_RISK,
    deidentified: false,
  };
}

export function isDeterministicContactReplyPreferenceForgetCommand(
  text: string | null,
): boolean {
  if (!text?.trim()) return false;
  return deterministicContactForgetCommands.has(
    normalizeClosedPreferenceKey(normalizeCandidateText(text)),
  );
}

export function isDeterministicContactMemoryDeleteCommand(
  text: string | null,
): boolean {
  if (!text?.trim()) return false;
  return deterministicContactMemoryDeleteCommands.has(
    normalizeClosedPreferenceKey(normalizeCandidateText(text)),
  );
}

export async function enqueueInboundMessageMemoryExtraction(
  tx: Prisma.TransactionClient,
  input: InboundMemoryExtractionInput,
): Promise<EnqueueMemoryExtractionResult> {
  return enqueueMemoryExtractionInTransaction(tx, input);
}

async function enqueueMemoryExtractionInTransaction(
  tx: Prisma.TransactionClient,
  input: InboundMemoryExtractionInput,
): Promise<EnqueueMemoryExtractionResult> {
  if (!hasMemoryExtractionStorage(tx)) {
    return { enqueued: false, reasonCode: "memory_storage_unavailable" };
  }
  const source = await loadMemoryExtractionSource(tx, input.messageId);
  if (!source) return { enqueued: false, reasonCode: "memory_source_not_found" };
  if (
    source.conversationId !== input.conversationId
    || source.conversation.representativeId !== input.representativeId
    || source.conversation.contactId !== input.contactId
  ) {
    return {
      enqueued: false,
      reasonCode: "memory_source_coordinates_mismatch",
    };
  }
  const actualChannel = parseMemoryExtractionChannel(
    source.conversation.sourceChannel,
  );
  if (!actualChannel) {
    return { enqueued: false, reasonCode: "memory_source_channel_missing" };
  }
  if (actualChannel !== input.channel) {
    return { enqueued: false, reasonCode: "memory_source_channel_mismatch" };
  }
  if (source.redactedAt) {
    return { enqueued: false, reasonCode: "memory_source_redacted" };
  }
  if (source.editedAt) {
    return { enqueued: false, reasonCode: "memory_source_edited" };
  }
  if (source.senderType !== MessageSenderType.AUDIENCE) {
    return {
      enqueued: false,
      reasonCode: "memory_source_not_audience_message",
    };
  }
  if (source.contentType !== MessageContentType.TEXT || !source.text?.trim()) {
    return { enqueued: false, reasonCode: "memory_source_not_text" };
  }

  const forgetCommand =
    isDeterministicContactReplyPreferenceForgetCommand(source.text)
    || isDeterministicContactMemoryDeleteCommand(source.text);
  const sourceChannel = toRepresentativeMemoryChannel(input.channel);
  await lockContactChannelMemoryCoordinate(tx, {
    representativeId: input.representativeId,
    contactId: input.contactId,
    sourceChannel,
  });
  const forgetBoundary = await loadLatestContactChannelMemoryForgetBoundary(
    tx,
    {
      representativeId: input.representativeId,
      contactId: input.contactId,
      sourceChannel,
    },
  );
  const contactChannelMemoryEpoch = currentContactChannelMemoryEpoch(
    forgetBoundary,
  );
  if (
    !isContactChannelMemorySourceAfterForgetBoundary(forgetBoundary, {
      contactChannelMemoryEpoch,
      memoryIngressOrdinal: source.memoryIngressOrdinal,
    })
  ) {
    return {
      enqueued: false,
      reasonCode: contactChannelMemoryForgetCutoffReasonCode,
    };
  }

  const policy = await tx.representativeMemoryPolicy.findUnique({
    where: { representativeId: input.representativeId },
    select: memoryExtractionPolicySelect,
  });
  if (!forgetCommand) {
    const gate = resolveMemoryExtractionPolicyGate(
      policy,
      input.channel,
      MemoryExtractionTrigger.CHANNEL_MESSAGE,
      MemoryScope.CONTACT_CHANNEL,
    );
    if (!gate.allowed) return { enqueued: false, reasonCode: gate.reasonCode };
    if (!await hasCurrentMemoryChannelDisclosureForMessage(tx, {
      representativeId: input.representativeId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      channel: input.channel,
      capability: "extract",
    })) {
      return {
        enqueued: false,
        reasonCode: "memory_channel_disclosure_missing",
      };
    }
  }

  const revisionDigest = hashText(`${source.id}\u0000${source.text ?? ""}`);
  const requestDigest = hashText("channel-message");
  const idempotencyKey = [
    "memory-extraction",
    extractionContractVersion,
    MemoryExtractionTrigger.CHANNEL_MESSAGE,
    MemoryScope.CONTACT_CHANNEL,
    input.channel,
    revisionDigest,
    requestDigest,
  ].join(":");
  const existing = await tx.memoryExtractionRun.findUnique({
    where: {
      representativeId_idempotencyKey: {
        representativeId: input.representativeId,
        idempotencyKey,
      },
    },
    select: { id: true },
  });
  if (existing) {
    return {
      enqueued: true,
      replayed: true,
      runId: existing.id,
      idempotencyKey,
    };
  }
  const run = await tx.memoryExtractionRun.create({
    data: {
      representativeId: input.representativeId,
      contactId: input.contactId,
      sourceChannel,
      sourceConversationId: input.conversationId,
      sourceMessageId: input.messageId,
      trigger: MemoryExtractionTrigger.CHANNEL_MESSAGE,
      status: MemoryExtractionStatus.QUEUED,
      idempotencyKey,
      contactChannelMemoryEpoch,
    },
    select: { id: true },
  });
  return {
    enqueued: true,
    replayed: false,
    runId: run.id,
    idempotencyKey,
  };
}

type MemoryExtractionFailureResult =
  | {
      status: "retrying";
      availableAt: Date;
      attemptCount: number;
    }
  | { status: "failed"; attemptCount: number }
  | { status: "lease_lost"; attemptCount: number };

export type MemoryExtractionWorkerDependencies = {
  claimNext?: () => Promise<MemoryExtractionWorkClaim | null>;
  processClaim?: (
    claim: MemoryExtractionWorkClaim,
  ) => Promise<{ processed: boolean; status: string }>;
  recordFailure?: (
    claim: MemoryExtractionWorkClaim,
    errorCode: string,
  ) => Promise<MemoryExtractionFailureResult>;
};

export async function processNextMemoryExtractionWork(
  dependencies: MemoryExtractionWorkerDependencies = {},
): Promise<MemoryExtractionWorkResult> {
  const claim = await (dependencies.claimNext ?? claimNextMemoryExtractionWork)();
  if (!claim) return { processed: false };
  return processClaimedMemoryExtractionWork(claim, dependencies);
}

export async function processMemoryExtractionRun(input: { runId: string }) {
  const claim = await claimMemoryExtractionRunById(input.runId);
  if (!claim) return { processed: false as const };
  return processClaimedMemoryExtractionWork(claim, {});
}

async function processClaimedMemoryExtractionWork(
  claim: MemoryExtractionWorkClaim,
  dependencies: MemoryExtractionWorkerDependencies,
): Promise<MemoryExtractionWorkResult> {
  try {
    const outcome = await (
      dependencies.processClaim ?? processClaimedMemoryExtractionRun
    )(claim);
    if (!outcome.processed) {
      return {
        processed: true,
        runId: claim.runId,
        status: "lease_lost",
        attemptCount: claim.attemptCount,
      };
    }
    return {
      processed: true,
      runId: claim.runId,
      status:
        outcome.status === MemoryExtractionStatus.CANCELED
          ? "canceled"
          : "completed",
      attemptCount: claim.attemptCount,
    };
  } catch {
    const errorCode = "memory_extraction_processing_failed";
    const failure = await (
      dependencies.recordFailure ?? recordMemoryExtractionFailure
    )(claim, errorCode);
    return {
      processed: true,
      runId: claim.runId,
      status: failure.status,
      attemptCount: failure.attemptCount,
      errorCode,
      ...(failure.status === "retrying"
        ? { availableAt: failure.availableAt }
        : {}),
    };
  }
}

async function processClaimedMemoryExtractionRun(
  claim: MemoryExtractionWorkClaim,
) {
  return runMemoryExtractionWriteTransaction((tx) =>
    processMemoryExtractionRunInTransaction(
      tx,
      { runId: claim.runId },
      { leaseToken: claim.leaseToken },
    ),
  );
}

/**
 * Serializes private-channel extraction with endpoint lifecycle changes and
 * proves that the source message still belongs to the currently active
 * representative endpoint. Exact deletion commands intentionally bypass this
 * gate: they only reduce retained data and remain bounded by the existing
 * source coordinates and contact-channel forget boundary.
 */
async function validatePrivateChannelExtractionEpoch(
  tx: Prisma.TransactionClient,
  input: {
    channel: MemoryExtractionChannel;
    representativeId: string;
    conversationId: string;
    source: MemoryExtractionSource;
  },
): Promise<PrivateChannelExtractionEpochErrorCode | null> {
  if (input.channel === "web") return null;

  const channelKind = input.channel === "matrix"
    ? RepresentativeChannelKind.MATRIX
    : RepresentativeChannelKind.TELEGRAM;
  const channelStateLockKey = input.channel === "matrix"
    ? `matrix-virtual-user:${input.representativeId}`
    : `telegram-bot-channel:${input.representativeId}`;
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${channelStateLockKey})
    )
  `;

  // The extraction transaction may have established its SERIALIZABLE snapshot
  // before waiting for the endpoint lifecycle advisory lock. Locking the
  // binding row after that wait forces PostgreSQL to reject that stale snapshot
  // when a disconnect/reconnect committed in the meantime; the surrounding
  // write-conflict retry then re-runs this check against the new lifecycle.
  await tx.$executeRaw`
    SELECT binding."id"
    FROM "RepresentativeChannelBinding" binding
    WHERE binding."representativeId" = ${input.representativeId}
      AND binding."kind" = CAST(${channelKind} AS "RepresentativeChannelKind")
    FOR UPDATE
  `;

  const currentBinding = await tx.representativeChannelBinding.findUnique({
    where: {
      representativeId_kind: {
        representativeId: input.representativeId,
        kind: channelKind,
      },
    },
    select: {
      id: true,
      connectionId: true,
      endpointAssignmentRevision: true,
      endpointLifecycleRevision: true,
      desiredState: true,
    },
  });
  if (!currentBinding || currentBinding.desiredState !== "ACTIVE") {
    return input.channel === "matrix"
      ? "matrix_memory_extraction_channel_not_active"
      : "telegram_memory_extraction_channel_not_active";
  }

  if (
    input.channel === "matrix"
    && !isPositiveSafeInteger(input.source.channelLifecycleRevision)
  ) {
    return "matrix_memory_extraction_source_lifecycle_missing";
  }

  const sourceBinding = input.source.channelBindingId
    ? await tx.conversationChannelBinding.findFirst({
        where: {
          id: input.source.channelBindingId,
          conversationId: input.conversationId,
          kind: channelKind,
        },
        select: {
          id: true,
          representativeBindingId: true,
          connectionId: true,
          representativeAssignmentRevision: true,
        },
      })
    : null;
  if (
    !sourceBinding
    || sourceBinding.representativeBindingId !== currentBinding.id
  ) {
    return input.channel === "matrix"
      ? "matrix_memory_extraction_channel_identity_changed"
      : "telegram_memory_extraction_channel_identity_changed";
  }

  if (input.channel === "matrix") {
    if (
      !isPositiveSafeInteger(currentBinding.endpointLifecycleRevision)
      || currentBinding.endpointLifecycleRevision
        !== input.source.channelLifecycleRevision
    ) {
      return "matrix_memory_extraction_channel_lifecycle_changed";
    }
  } else if (
    !sourceBinding.connectionId?.trim()
    || !currentBinding.connectionId?.trim()
    || sourceBinding.connectionId !== currentBinding.connectionId
  ) {
    return "telegram_memory_extraction_channel_identity_changed";
  }

  if (
    !isPositiveSafeInteger(sourceBinding.representativeAssignmentRevision)
    || !isPositiveSafeInteger(currentBinding.endpointAssignmentRevision)
  ) {
    return input.channel === "matrix"
      ? "matrix_memory_extraction_channel_assignment_missing"
      : "telegram_memory_extraction_channel_assignment_missing";
  }
  if (
    sourceBinding.representativeAssignmentRevision
      !== currentBinding.endpointAssignmentRevision
  ) {
    return input.channel === "matrix"
      ? "matrix_memory_extraction_channel_assignment_changed"
      : "telegram_memory_extraction_channel_assignment_changed";
  }
  return null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export async function processMemoryExtractionRunInTransaction(
  tx: Prisma.TransactionClient,
  input: { runId: string },
  dependencies: {
    classifier?: MemoryCandidateClassifier;
    leaseToken?: string;
  } = {},
) {
  const now = new Date();
  const leaseToken = dependencies.leaseToken ?? randomUUID();
  const run = await tx.memoryExtractionRun.findUnique({
    where: { id: input.runId },
    include: {
      sourceMessage: {
        select: memoryExtractionSourceSelect,
      },
    },
  }) as MemoryExtractionRunWithSource | null;
  if (!run) throw new Error("Memory extraction run not found.");
  const terminalStatuses: MemoryExtractionStatus[] = [
      MemoryExtractionStatus.SUCCEEDED,
      MemoryExtractionStatus.PARTIAL,
      MemoryExtractionStatus.FAILED,
      MemoryExtractionStatus.CANCELED,
  ];
  if (terminalStatuses.includes(run.status)) {
    return { processed: false, runId: run.id, status: run.status };
  }
  if (
    dependencies.leaseToken
    && (
      run.status !== MemoryExtractionStatus.RUNNING
      || run.leaseToken !== dependencies.leaseToken
      || !run.leaseExpiresAt
      || run.leaseExpiresAt <= now
    )
  ) {
    return { processed: false, runId: run.id, status: "LEASE_LOST" };
  }
  if (!run.sourceMessage || !run.contactId || !run.sourceConversationId) {
    return cancelMemoryExtractionRun(
      tx,
      run.id,
      "memory_source_missing",
      now,
      dependencies.leaseToken,
    );
  }
  const parsedCoordinates = parseExtractionCoordinates(run.idempotencyKey);
  if (!parsedCoordinates) {
    return cancelMemoryExtractionRun(
      tx,
      run.id,
      "invalid_extraction_coordinates",
      now,
      dependencies.leaseToken,
    );
  }
  if (parsedCoordinates.trigger !== run.trigger) {
    return cancelMemoryExtractionRun(
      tx,
      run.id,
      "extraction_trigger_mismatch",
      now,
      dependencies.leaseToken,
    );
  }
  if (run.trigger !== MemoryExtractionTrigger.CHANNEL_MESSAGE) {
    return cancelMemoryExtractionRun(
      tx,
      run.id,
      "memory_extraction_trigger_retired",
      now,
      dependencies.leaseToken,
    );
  }
  if (parsedCoordinates.scope !== MemoryScope.CONTACT_CHANNEL) {
    return cancelMemoryExtractionRun(
      tx,
      run.id,
      "representative_experience_trigger_not_allowed",
      now,
      dependencies.leaseToken,
    );
  }
  const source = run.sourceMessage;
  const actualChannel = parseMemoryExtractionChannel(
    source.conversation.sourceChannel,
  );
  if (
    source.conversationId !== run.sourceConversationId
    || source.conversation.representativeId !== run.representativeId
    || source.conversation.contactId !== run.contactId
    || actualChannel !== parsedCoordinates.channel
    || toRepresentativeChannelKind(parsedCoordinates.channel) !== run.sourceChannel
  ) {
    return cancelMemoryExtractionRun(
      tx,
      run.id,
      "memory_source_coordinates_changed",
      now,
      dependencies.leaseToken,
    );
  }
  const currentRevisionDigest = hashText(`${source.id}\u0000${source.text ?? ""}`);
  if (currentRevisionDigest !== parsedCoordinates.revisionDigest) {
    return cancelMemoryExtractionRun(
      tx,
      run.id,
      "source_message_edited",
      now,
      dependencies.leaseToken,
    );
  }
  if (source.redactedAt) {
    return cancelMemoryExtractionRun(
      tx,
      run.id,
      "source_message_redacted",
      now,
      dependencies.leaseToken,
    );
  }
  if (source.editedAt) {
    return cancelMemoryExtractionRun(
      tx,
      run.id,
      "source_message_edited",
      now,
      dependencies.leaseToken,
    );
  }
  const deleteAllCommand =
    parsedCoordinates.scope === MemoryScope.CONTACT_CHANNEL
    && source.senderType === MessageSenderType.AUDIENCE
    && source.contentType === MessageContentType.TEXT
    && isDeterministicContactMemoryDeleteCommand(source.text);
  const forgetPreferenceCommand =
    parsedCoordinates.scope === MemoryScope.CONTACT_CHANNEL
    && source.senderType === MessageSenderType.AUDIENCE
    && source.contentType === MessageContentType.TEXT
    && isDeterministicContactReplyPreferenceForgetCommand(source.text);
  const forgetCommand = deleteAllCommand || forgetPreferenceCommand;
  let exactSharedSourceEvidence: ExactMessageIdentityEvidence | null = null;
  if (!forgetCommand) {
    // Private-channel delivery takes the endpoint/room fence before the
    // contact-memory coordinate. Keep extraction in the same canonical order
    // so extraction and a provider send cannot deadlock each other.
    const privateChannelEpochError =
      await validatePrivateChannelExtractionEpoch(tx, {
        channel: parsedCoordinates.channel,
        representativeId: run.representativeId,
        conversationId: run.sourceConversationId,
        source,
      });
    if (privateChannelEpochError) {
      return cancelMemoryExtractionRun(
        tx,
        run.id,
        privateChannelEpochError,
        now,
        dependencies.leaseToken,
      );
    }
    exactSharedSourceEvidence =
      await lockAndResolveExactMessageIdentityEvidence(tx, {
        representativeId: run.representativeId,
        contactId: run.contactId,
        conversationId: run.sourceConversationId,
        messageId: source.id,
        sourceChannel: run.sourceChannel,
      });
    if (exactSharedSourceEvidence) {
      await lockContactSharedMemoryCoordinate(tx, {
        representativeId: run.representativeId,
        audienceIdentityId:
          exactSharedSourceEvidence.canonicalAudienceIdentityId,
      });
    }
  }
  await lockContactChannelMemoryCoordinate(tx, {
    representativeId: run.representativeId,
    contactId: run.contactId,
    sourceChannel: run.sourceChannel,
  });
  const forgetBoundary = await loadLatestContactChannelMemoryForgetBoundary(
    tx,
    {
      representativeId: run.representativeId,
      contactId: run.contactId,
      sourceChannel: run.sourceChannel,
    },
  );
  if (
    !isContactChannelMemorySourceAfterForgetBoundary(forgetBoundary, {
      contactChannelMemoryEpoch: run.contactChannelMemoryEpoch,
      memoryIngressOrdinal: source.memoryIngressOrdinal,
    })
  ) {
    return cancelMemoryExtractionRun(
      tx,
      run.id,
      contactChannelMemoryForgetCutoffReasonCode,
      now,
      dependencies.leaseToken,
    );
  }
  const policy = await tx.representativeMemoryPolicy.findUnique({
    where: { representativeId: run.representativeId },
    select: memoryExtractionPolicySelect,
  });
  if (!forgetCommand) {
    const gate = resolveMemoryExtractionPolicyGate(
      policy,
      parsedCoordinates.channel,
      run.trigger,
      parsedCoordinates.scope,
    );
    if (!gate.allowed) {
      return cancelMemoryExtractionRun(
        tx,
        run.id,
        gate.reasonCode,
        now,
        dependencies.leaseToken,
      );
    }
    if (!await hasCurrentMemoryChannelDisclosureForMessage(tx, {
      representativeId: run.representativeId,
      contactId: run.contactId,
      conversationId: run.sourceConversationId,
      messageId: source.id,
      channel: parsedCoordinates.channel,
      capability: "extract",
    })) {
      return cancelMemoryExtractionRun(
        tx,
        run.id,
        "memory_channel_disclosure_missing",
        now,
        dependencies.leaseToken,
      );
    }
  }

  if (!dependencies.leaseToken) {
    const claimed = await tx.memoryExtractionRun.updateMany({
      where: {
        id: run.id,
        attemptCount: { lt: maximumExtractionAttempts },
        OR: [
          {
            status: MemoryExtractionStatus.QUEUED,
            availableAt: { lte: now },
          },
          {
            status: MemoryExtractionStatus.RUNNING,
            leaseExpiresAt: { lt: now },
          },
        ],
      },
      data: {
        status: MemoryExtractionStatus.RUNNING,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + extractionLeaseMilliseconds),
        startedAt: now,
        finishedAt: null,
        errorCode: null,
        attemptCount: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      return { processed: false, runId: run.id, status: run.status };
    }
  }

  if (
    parsedCoordinates.scope === MemoryScope.CONTACT_CHANNEL
    && source.senderType === MessageSenderType.AUDIENCE
    && source.contentType === MessageContentType.TEXT
    && forgetCommand
  ) {
    const deletionInput = {
      representativeId: run.representativeId,
      contactId: run.contactId,
      sourceChannel: run.sourceChannel,
      sourceMessageId: source.id,
      sourceHash: hashText(normalizeCandidateText(source.text ?? "")),
      occurredAt: now,
    };
    const reasonCode = deleteAllCommand
      ? (await requestAutomaticContactChannelMemoryDeletionInTransaction(
          tx,
          deletionInput,
        )).matchedCount > 0
        ? "contact_channel_memory_delete_requested"
        : "contact_channel_memory_not_found"
      : (await requestAutomaticContactReplyPreferenceDeletionInTransaction(
          tx,
          deletionInput,
        )).matched
        ? "contact_reply_preference_forget_requested"
        : "contact_reply_preference_not_found";
    const completed = await tx.memoryExtractionRun.updateMany({
      where: { id: run.id, leaseToken },
      data: {
        status: MemoryExtractionStatus.SUCCEEDED,
        candidateCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        quarantinedCount: 0,
        reasonCounts: { [reasonCode]: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
        finishedAt: new Date(),
        errorCode: null,
      },
    });
    if (completed.count !== 1) {
      throw new Error("Memory extraction lease changed before completion.");
    }
    return {
      processed: true,
      runId: run.id,
      status: MemoryExtractionStatus.SUCCEEDED,
      candidateCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      quarantinedCount: 0,
      reasonCode,
    };
  }

  const classification = safelyClassifyMemoryCandidate(
    {
      text: source.text,
      senderType: source.senderType,
      contentType: source.contentType,
      scope: parsedCoordinates.scope,
    },
    dependencies.classifier ?? classifyMemoryCandidate,
  );
  let candidateCount = 0;
  let acceptedCount = 0;
  let rejectedCount = 0;
  let quarantinedCount = 0;
  const reasonCode = classification.kind === "none"
    ? classification.reasonCode
    : classification.kind === "marker"
      ? classification.safetyReasonCode
      : classification.extractionReasonCode;
  const shouldCreatePrimaryCandidate =
    parsedCoordinates.scope !== MemoryScope.CONTACT_CHANNEL
    || policy!.contactMemoryEnabled;
  const reasonCounts: Record<string, number> = shouldCreatePrimaryCandidate
    ? { [reasonCode]: 1 }
    : {};
  let resultReasonCode = reasonCode;

  if (classification.kind !== "none" && shouldCreatePrimaryCandidate) {
    const contentPurgedAt = classification.kind === "marker" ? now : null;
    const safeText = classification.kind === "reviewable"
      ? classification.safeText
      : null;
    const summary = classification.kind === "reviewable"
      ? classification.summary
      : null;
    const contentHash = safeText ? hashText(safeText) : null;
    const candidateStatus = classification.kind === "reviewable"
      ? MemoryCandidateStatus.PENDING_REVIEW
      : classification.status;
    const semanticKey = classification.kind === "reviewable"
      ? buildMemorySemanticKey(classification)
      : null;
    const candidateDedupeKey = [
      "memory-candidate",
      extractionContractVersion,
      parsedCoordinates.scope,
      run.contactId,
      parsedCoordinates.scope === MemoryScope.CONTACT_CHANNEL
        ? run.sourceChannel
        : "representative",
      semanticKey ?? "safety-marker",
      source.id,
      contentHash ?? reasonCode,
      reasonCode,
    ].join(":");
    const candidate = await tx.memoryCandidate.upsert({
      where: {
        representativeId_dedupeKey: {
          representativeId: run.representativeId,
          dedupeKey: candidateDedupeKey,
        },
      },
      create: {
        representativeId: run.representativeId,
        extractionRunId: run.id,
        contactId:
          parsedCoordinates.scope === MemoryScope.CONTACT_CHANNEL
            ? run.contactId
            : null,
        scope: parsedCoordinates.scope,
        scopeChannel:
          parsedCoordinates.scope === MemoryScope.CONTACT_CHANNEL
            ? run.sourceChannel
            : null,
        originChannel: run.sourceChannel,
        category: classification.category,
        sourceKind: MemorySourceKind.AUDIENCE_MESSAGE,
        safeText,
        summary,
        contentHash,
        contentPurgedAt,
        dedupeKey: candidateDedupeKey,
        semanticKey,
        status: candidateStatus,
        safetyClass: classification.safetyClass,
        safetyReasonCode:
          classification.kind === "marker"
            ? classification.safetyReasonCode
            : null,
        extractionReasonCode:
          classification.kind === "reviewable"
            ? classification.extractionReasonCode
            : "safety_classification_rejected",
        sourceContactId: run.contactId,
        sourceConversationId: run.sourceConversationId,
        sourceMessageId: source.id,
        deidentifiedAt:
          classification.kind === "reviewable" && classification.deidentified
            ? now
            : null,
        expiresAt: new Date(
          now.getTime() + Math.max(1, policy!.retentionDays) * 86_400_000,
        ),
      },
      update: {},
    });
    const sourceHash = hashText(normalizeCandidateText(source.text ?? ""));
    if (classification.kind === "reviewable") {
      await applyAutomaticMemoryPolicyInTransaction(tx, {
        candidateId: candidate.id,
        sourceHash,
        confidence: 1,
      }, now);
    } else {
      await recordAutomaticMarkerPolicyDecisionInTransaction(tx, {
        candidateId: candidate.id,
        sourceHash,
        confidence: 1,
      });
    }
    candidateCount = 1;
    if (classification.kind === "reviewable") acceptedCount = 1;
    else if (classification.status === MemoryCandidateStatus.BLOCKED) {
      rejectedCount = 1;
    } else {
      quarantinedCount = 1;
    }

    if (
      classification.kind === "reviewable"
      && parsedCoordinates.scope === MemoryScope.CONTACT_CHANNEL
      && policy!.contactMemoryCrossChannelEnabled
    ) {
      const sharingEligibility =
        await resolveContactMemorySharingEligibility(tx, {
          representativeId: run.representativeId,
          contactId: run.contactId,
          sourceChannel: run.sourceChannel,
          policy: {
            contactMemoryCrossChannelEnabled:
              policy!.contactMemoryCrossChannelEnabled,
            revision: policy!.revision,
          },
          sourceEvidence: exactSharedSourceEvidence,
        });
      if (sharingEligibility.eligible) {
        const sharedResult = await createSharedContactMemoryCandidate(tx, {
          run,
          source,
          sourceHash,
          classification,
          audienceIdentityId: sharingEligibility.audienceIdentityId,
          sourceEvidence: exactSharedSourceEvidence!,
          retentionDays: policy!.retentionDays,
          occurredAt: now,
        });
        candidateCount += 1;
        if (new Set<MemoryPolicyDecisionOutcome>([
          MemoryPolicyDecisionOutcome.ACTIVATED,
          MemoryPolicyDecisionOutcome.UPDATED,
          MemoryPolicyDecisionOutcome.UNCHANGED,
        ]).has(sharedResult.outcome)) {
          acceptedCount += 1;
          reasonCounts.cross_channel_contact_memory_promoted =
            (reasonCounts.cross_channel_contact_memory_promoted ?? 0) + 1;
        } else {
          rejectedCount += 1;
          reasonCounts.cross_channel_contact_memory_rejected =
            (reasonCounts.cross_channel_contact_memory_rejected ?? 0) + 1;
        }
      }
    }

    if (
      classification.kind === "reviewable"
      && parsedCoordinates.scope === MemoryScope.CONTACT_CHANNEL
      && policy!.representativeExperienceEnabled
    ) {
      const representativeEvidence = await createRepresentativeEvidenceCandidate(
        tx,
        {
          run,
          source,
          sourceHash,
          retentionDays: policy!.retentionDays,
          occurredAt: now,
        },
      );
      if (representativeEvidence) {
        candidateCount += 1;
        acceptedCount += 1;
        reasonCounts[representativeEvidence.reasonCode] =
          (reasonCounts[representativeEvidence.reasonCode] ?? 0) + 1;
      }
    }
  }

  if (
    !shouldCreatePrimaryCandidate
    && classification.kind === "reviewable"
    && parsedCoordinates.scope === MemoryScope.CONTACT_CHANNEL
    && policy!.representativeExperienceEnabled
  ) {
    const representativeEvidence = await createRepresentativeEvidenceCandidate(
      tx,
      {
        run,
        source,
        sourceHash: hashText(normalizeCandidateText(source.text ?? "")),
        retentionDays: policy!.retentionDays,
        occurredAt: now,
      },
    );
    if (representativeEvidence) {
      candidateCount = 1;
      acceptedCount = 1;
      resultReasonCode = representativeEvidence.reasonCode;
      reasonCounts[representativeEvidence.reasonCode] =
        (reasonCounts[representativeEvidence.reasonCode] ?? 0) + 1;
    }
  }

  const completedAt = new Date();
  const completed = await tx.memoryExtractionRun.updateMany({
    where: { id: run.id, leaseToken },
    data: {
      status: MemoryExtractionStatus.SUCCEEDED,
      candidateCount,
      acceptedCount,
      rejectedCount,
      quarantinedCount,
      reasonCounts,
      leaseToken: null,
      leaseExpiresAt: null,
      finishedAt: completedAt,
      errorCode: null,
    },
  });
  if (completed.count !== 1) {
    throw new Error("Memory extraction lease changed before completion.");
  }
  return {
    processed: true,
    runId: run.id,
    status: MemoryExtractionStatus.SUCCEEDED,
    candidateCount,
    acceptedCount,
    rejectedCount,
    quarantinedCount,
    reasonCode: resultReasonCode,
  };
}

async function createSharedContactMemoryCandidate(
  tx: Prisma.TransactionClient,
  input: {
    run: MemoryExtractionRunWithSource;
    source: MemoryExtractionSource;
    sourceHash: string;
    classification: Extract<
      MemoryCandidateClassification,
      { kind: "reviewable" }
    >;
    audienceIdentityId: string;
    sourceEvidence: ExactMessageIdentityEvidence;
    retentionDays: number;
    occurredAt: Date;
  },
) {
  if (!input.run.contactId || !input.run.sourceConversationId) {
    throw new Error("Shared Contact Memory source coordinates are unavailable.");
  }
  const semanticKey = buildMemorySemanticKey(input.classification);
  const contentHash = hashText(input.classification.safeText);
  const dedupeKey = [
    "shared-contact-memory-candidate",
    extractionContractVersion,
    input.audienceIdentityId,
    semanticKey,
    input.source.id,
    contentHash,
  ].join(":");
  const candidate = await tx.memoryCandidate.upsert({
    where: {
      representativeId_dedupeKey: {
        representativeId: input.run.representativeId,
        dedupeKey,
      },
    },
    create: {
      representativeId: input.run.representativeId,
      extractionRunId: input.run.id,
      contactId: null,
      audienceIdentityId: input.audienceIdentityId,
      scope: MemoryScope.CONTACT_SHARED,
      scopeChannel: null,
      originChannel: input.run.sourceChannel,
      category: input.classification.category,
      sourceKind: MemorySourceKind.AUDIENCE_MESSAGE,
      safeText: input.classification.safeText,
      summary: input.classification.summary,
      contentHash,
      contentPurgedAt: null,
      dedupeKey,
      semanticKey,
      status: MemoryCandidateStatus.PENDING_REVIEW,
      safetyClass: input.classification.safetyClass,
      safetyReasonCode: null,
      extractionReasonCode: input.classification.extractionReasonCode,
      sourceContactId: input.run.contactId,
      sourceConversationId: input.run.sourceConversationId,
      sourceMessageId: input.source.id,
      // CONTACT_SHARED is projected outside a channel-specific contact
      // namespace. The classifier has reduced the source to a closed,
      // low-risk structured value by this point; record that transformation
      // explicitly so every shared version carries auditable deidentification
      // evidence rather than relying on its canonical identity coordinate.
      deidentifiedAt: input.occurredAt,
      expiresAt: new Date(
        input.occurredAt.getTime()
          + Math.max(1, input.retentionDays) * 86_400_000,
      ),
    },
    update: {},
  });
  return applyAutomaticMemoryPolicyInTransaction(tx, {
    candidateId: candidate.id,
    sourceHash: input.sourceHash,
    confidence: 1,
    sharedSourceEvidence: input.sourceEvidence,
  }, input.occurredAt);
}

async function createRepresentativeEvidenceCandidate(
  tx: Prisma.TransactionClient,
  input: {
    run: MemoryExtractionRunWithSource;
    source: MemoryExtractionSource;
    sourceHash: string;
    retentionDays: number;
    occurredAt: Date;
  },
) {
  if (!input.run.contactId || !input.run.sourceConversationId) return null;
  const classification = safelyClassifyMemoryCandidate(
    {
      text: input.source.text,
      senderType: input.source.senderType,
      contentType: input.source.contentType,
      scope: MemoryScope.REPRESENTATIVE,
    },
    classifyMemoryCandidate,
  );
  if (classification.kind !== "reviewable" || !classification.deidentified) {
    return null;
  }
  const semanticKey = buildMemorySemanticKey(classification);
  const contentHash = hashText(classification.safeText);
  const dedupeKey = [
    "representative-evidence",
    extractionContractVersion,
    semanticKey,
    input.source.id,
    contentHash,
  ].join(":");
  const candidate = await tx.memoryCandidate.upsert({
    where: {
      representativeId_dedupeKey: {
        representativeId: input.run.representativeId,
        dedupeKey,
      },
    },
    create: {
      representativeId: input.run.representativeId,
      extractionRunId: input.run.id,
      contactId: null,
      audienceIdentityId: null,
      scope: MemoryScope.REPRESENTATIVE,
      scopeChannel: null,
      originChannel: input.run.sourceChannel,
      category: classification.category,
      sourceKind: MemorySourceKind.AUDIENCE_MESSAGE,
      safeText: classification.safeText,
      summary: classification.summary,
      contentHash,
      contentPurgedAt: null,
      dedupeKey,
      semanticKey,
      status: MemoryCandidateStatus.EXTRACTED,
      safetyClass: classification.safetyClass,
      safetyReasonCode: null,
      extractionReasonCode: classification.extractionReasonCode,
      sourceContactId: input.run.contactId,
      sourceConversationId: input.run.sourceConversationId,
      sourceMessageId: input.source.id,
      deidentifiedAt: input.occurredAt,
      expiresAt: new Date(
        input.occurredAt.getTime()
          + Math.max(1, input.retentionDays) * 86_400_000,
      ),
    },
    update: {},
  });
  await processRepresentativeEvidenceCandidateInTransaction(tx, {
    candidateId: candidate.id,
    representativeId: input.run.representativeId,
    semanticKey,
    sourceHash: input.sourceHash,
    occurredAt: input.occurredAt,
  });
  return { reasonCode: classification.extractionReasonCode };
}

async function processRepresentativeEvidenceCandidateInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    candidateId: string;
    representativeId: string;
    semanticKey: string;
    sourceHash: string;
    occurredAt: Date;
  },
) {
  const evidence = await tx.memoryCandidate.findMany({
    where: {
      representativeId: input.representativeId,
      scope: MemoryScope.REPRESENTATIVE,
      semanticKey: input.semanticKey,
      status: {
        in: [
          MemoryCandidateStatus.EXTRACTED,
          MemoryCandidateStatus.APPROVED,
        ],
      },
      safetyClass: MemorySafetyClass.LOW_RISK,
      contentPurgedAt: null,
      deidentifiedAt: { not: null },
      extractionRun: {
        is: { trigger: MemoryExtractionTrigger.CHANNEL_MESSAGE },
      },
    },
    select: {
      id: true,
      sourceContactId: true,
      sourceConversationId: true,
    },
  });
  const distinctContacts = new Set(
    evidence.map((item) => item.sourceContactId),
  );
  const distinctConversations = new Set(
    evidence.map((item) => item.sourceConversationId),
  );
  if (distinctContacts.size < 2 || distinctConversations.size < 2) {
    return recordRepresentativeEvidencePolicyDecisionInTransaction(tx, {
      candidateId: input.candidateId,
      sourceHash: input.sourceHash,
      confidence: 1,
    });
  }
  await tx.memoryCandidate.update({
    where: { id: input.candidateId },
    data: { status: MemoryCandidateStatus.PENDING_REVIEW },
  });
  return applyAutomaticMemoryPolicyInTransaction(tx, {
    candidateId: input.candidateId,
    sourceHash: input.sourceHash,
    confidence: 1,
  }, input.occurredAt);
}

export async function invalidateMemoryExtractionForSourceMessage(
  tx: Prisma.TransactionClient,
  input: {
    messageId: string;
    reasonCode: "source_message_edited" | "source_message_redacted";
    occurredAt?: Date;
  },
) {
  if (!hasMemoryInvalidationStorage(tx)) {
    return { canceledRunCount: 0, purgedCandidateCount: 0 };
  }
  const occurredAt = input.occurredAt ?? new Date();
  const governedStorageAvailable = hasGovernedMemoryInvalidationStorage(tx);
  const memoryIdsToSuppress = new Set<string>();
  const memoryIdsToCleanUp = new Set<string>();

  if (governedStorageAvailable) {
    // Include already-suppressed rows because the Postgres source-message
    // trigger may have fenced Recall before this application hook runs. The
    // projection cleanup is still application-owned and must not be skipped.
    const directlyAffectedMemories = await tx.governedMemory.findMany({
      where: {
        status: {
          notIn: [
            GovernedMemoryStatus.DELETE_PENDING,
            GovernedMemoryStatus.DELETED,
          ],
        },
        currentVersion: {
          is: {
            sourceCandidate: {
              is: { sourceMessageId: input.messageId },
            },
          },
        },
      },
      select: { id: true, status: true },
    });
    for (const memory of directlyAffectedMemories) {
      memoryIdsToCleanUp.add(memory.id);
      if (memory.status === GovernedMemoryStatus.ACTIVE) {
        memoryIdsToSuppress.add(memory.id);
      }
    }

    // A representative experience may have been activated by a different
    // source candidate. Re-evaluate every semantic coordinate touched by the
    // edited/redacted source so losing non-current evidence cannot leave an
    // under-corroborated pattern available to Recall.
    const affectedRepresentativeCandidates = await tx.memoryCandidate.findMany({
      where: {
        sourceMessageId: input.messageId,
        scope: MemoryScope.REPRESENTATIVE,
        semanticKey: { not: null },
      },
      select: { representativeId: true, semanticKey: true },
    });
    const affectedCoordinates = new Map<
      string,
      { representativeId: string; semanticKey: string }
    >();
    for (const candidate of affectedRepresentativeCandidates) {
      if (!candidate.semanticKey) continue;
      affectedCoordinates.set(
        `${candidate.representativeId}\u0000${candidate.semanticKey}`,
        {
          representativeId: candidate.representativeId,
          semanticKey: candidate.semanticKey,
        },
      );
    }

    for (const coordinate of affectedCoordinates.values()) {
      const remainingEvidence = await tx.memoryCandidate.findMany({
        where: {
          representativeId: coordinate.representativeId,
          scope: MemoryScope.REPRESENTATIVE,
          semanticKey: coordinate.semanticKey,
          sourceMessageId: { not: input.messageId },
          status: {
            in: [
              MemoryCandidateStatus.EXTRACTED,
              MemoryCandidateStatus.APPROVED,
            ],
          },
          safetyClass: MemorySafetyClass.LOW_RISK,
          contentPurgedAt: null,
          deidentifiedAt: { not: null },
          extractionRun: {
            is: { trigger: MemoryExtractionTrigger.CHANNEL_MESSAGE },
          },
          sourceMessage: {
            is: {
              senderType: MessageSenderType.AUDIENCE,
              contentType: MessageContentType.TEXT,
              editedAt: null,
              redactedAt: null,
            },
          },
        },
        select: {
          sourceContactId: true,
          sourceConversationId: true,
        },
      });
      const distinctContacts = new Set(
        remainingEvidence.map((candidate) => candidate.sourceContactId),
      );
      const distinctConversations = new Set(
        remainingEvidence.map((candidate) => candidate.sourceConversationId),
      );
      if (distinctContacts.size >= 2 && distinctConversations.size >= 2) {
        continue;
      }
      const underCorroboratedMemories = await tx.governedMemory.findMany({
        where: {
          representativeId: coordinate.representativeId,
          scope: MemoryScope.REPRESENTATIVE,
          semanticKey: coordinate.semanticKey,
          status: GovernedMemoryStatus.ACTIVE,
        },
        select: { id: true, status: true },
      });
      for (const memory of underCorroboratedMemories) {
        memoryIdsToSuppress.add(memory.id);
        memoryIdsToCleanUp.add(memory.id);
      }
    }
  }

  const suppressedMemories = governedStorageAvailable
    && memoryIdsToSuppress.size > 0
    ? await tx.governedMemory.updateMany({
        where: {
          id: { in: [...memoryIdsToSuppress] },
          status: GovernedMemoryStatus.ACTIVE,
        },
        data: {
          status: GovernedMemoryStatus.SUPPRESSED,
          recallDisabledAt: occurredAt,
          suppressedAt: occurredAt,
        },
      })
    : { count: 0 };
  if (governedStorageAvailable && memoryIdsToCleanUp.size > 0) {
    await queueInvalidatedMemoryProjectionCleanup(
      tx,
      [...memoryIdsToCleanUp],
      occurredAt,
    );
  }
  const canceledQueuedRuns = await tx.memoryExtractionRun.updateMany({
    where: {
      sourceMessageId: input.messageId,
      status: MemoryExtractionStatus.QUEUED,
    },
    data: {
      status: MemoryExtractionStatus.CANCELED,
      leaseToken: null,
      leaseExpiresAt: null,
      startedAt: occurredAt,
      finishedAt: occurredAt,
      errorCode: input.reasonCode,
    },
  });
  const canceledRunningRuns = await tx.memoryExtractionRun.updateMany({
    where: {
      sourceMessageId: input.messageId,
      status: MemoryExtractionStatus.RUNNING,
    },
    data: {
      status: MemoryExtractionStatus.CANCELED,
      leaseToken: null,
      leaseExpiresAt: null,
      finishedAt: occurredAt,
      errorCode: input.reasonCode,
    },
  });

  const reviewableCandidates = await tx.memoryCandidate.findMany({
    where: {
      sourceMessageId: input.messageId,
      contentPurgedAt: null,
      status: {
        in: [
          MemoryCandidateStatus.EXTRACTED,
          MemoryCandidateStatus.PENDING_REVIEW,
        ],
      },
      version: null,
    },
    select: {
      id: true,
      representativeId: true,
      status: true,
      policyDecision: { select: { id: true } },
    },
  });
  for (const candidate of reviewableCandidates) {
    const status = candidate.status === MemoryCandidateStatus.PENDING_REVIEW
      ? MemoryCandidateStatus.EXPIRED
      : MemoryCandidateStatus.BLOCKED;
    await tx.memoryCandidate.update({
      where: { id: candidate.id },
      data: {
        status,
        // Automatic decisions make candidate safety/provenance coordinates
        // immutable. The source invalidation may still perform the permitted
        // controlled purge and terminal status transition without rewriting
        // that historical decision's inputs.
        ...(candidate.policyDecision
          ? {}
          : {
              safetyClass: MemorySafetyClass.PROHIBITED,
              safetyReasonCode: input.reasonCode,
            }),
        safeText: null,
        summary: null,
        contentPurgedAt: occurredAt,
      },
    });
  }
  return {
    canceledRunCount: canceledQueuedRuns.count + canceledRunningRuns.count,
    purgedCandidateCount: reviewableCandidates.length,
    suppressedMemoryCount: suppressedMemories.count,
  };
}

function prohibitedMarker(
  category: MemoryCategory,
  safetyReasonCode: Extract<
    MemoryCandidateClassification,
    { kind: "marker" }
  >["safetyReasonCode"],
): MemoryCandidateClassification {
  return {
    kind: "marker",
    category,
    status: MemoryCandidateStatus.BLOCKED,
    safetyClass: MemorySafetyClass.PROHIBITED,
    safetyReasonCode,
  };
}

function sensitiveMarker(
  category: MemoryCategory,
  safetyReasonCode: Extract<
    MemoryCandidateClassification,
    { kind: "marker" }
  >["safetyReasonCode"],
): MemoryCandidateClassification {
  return {
    kind: "marker",
    category,
    status: MemoryCandidateStatus.QUARANTINED,
    safetyClass: MemorySafetyClass.SENSITIVE,
    safetyReasonCode,
  };
}

function safelyClassifyMemoryCandidate(
  input: Parameters<typeof classifyMemoryCandidate>[0],
  classifier: MemoryCandidateClassifier,
): MemoryCandidateClassification {
  try {
    const result = classifier(input);
    if (isValidMemoryCandidateClassification(result, input.scope)) return result;
  } catch {
    // The source text must never be copied into diagnostics when classification
    // fails. A bodyless quarantine marker preserves only the stable reason.
  }
  return sensitiveMarker(
    input.scope === MemoryScope.REPRESENTATIVE
      ? MemoryCategory.REPRESENTATIVE_SAFETY_PATTERN
      : MemoryCategory.CONTACT_CONTEXT,
    "safety_classification_failed",
  );
}

function isValidMemoryCandidateClassification(
  value: MemoryCandidateClassification,
  scope: MemoryScope,
): boolean {
  if (!value || typeof value !== "object") return false;
  if (value.kind === "none") {
    return value.reasonCode === "no_allowlisted_structured_fact";
  }
  if (value.kind === "marker") {
    const markerCategories = scope === MemoryScope.REPRESENTATIVE
      ? new Set<MemoryCategory>([
          MemoryCategory.REPRESENTATIVE_RESPONSE_PATTERN,
          MemoryCategory.REPRESENTATIVE_SERVICE_PATTERN,
          MemoryCategory.REPRESENTATIVE_SAFETY_PATTERN,
          MemoryCategory.REPRESENTATIVE_ROUTING_PATTERN,
        ])
      : new Set<MemoryCategory>([
          MemoryCategory.CONTACT_PREFERENCE,
          MemoryCategory.CONTACT_GOAL,
          MemoryCategory.CONTACT_CONSTRAINT,
          MemoryCategory.CONTACT_CONTEXT,
        ]);
    if (!markerCategories.has(value.category)) return false;
    return markerSafetyReasonCodes.has(value.safetyReasonCode)
      && (
        (
          value.status === MemoryCandidateStatus.BLOCKED
          && value.safetyClass === MemorySafetyClass.PROHIBITED
        )
        || (
          value.status === MemoryCandidateStatus.QUARANTINED
          && value.safetyClass === MemorySafetyClass.SENSITIVE
        )
      );
  }
  const canonicalPayload = scope === MemoryScope.REPRESENTATIVE
    ? value.category === MemoryCategory.REPRESENTATIVE_RESPONSE_PATTERN
      && value.extractionReasonCode === "deidentified_response_pattern"
      && value.safeText === representativeResponseSafeText
      && value.summary === representativeResponseSummary
      && value.deidentified
    : value.category === MemoryCategory.CONTACT_PREFERENCE
      && value.extractionReasonCode === "explicit_contact_preference"
      && value.safeText === value.summary
      && closedCommunicationPreferenceValues.has(value.safeText);
  return canonicalPayload
    && reviewableExtractionReasonCodes.has(value.extractionReasonCode)
    && value.safetyClass === MemorySafetyClass.LOW_RISK
    && Boolean(value.safeText.trim())
    && Boolean(value.summary.trim())
    && value.safeText.length <= 8000
    && value.summary.length <= 2000
    && !containsUnsafeMemoryContent(`${value.safeText}\n${value.summary}`);
}

function normalizeCandidateText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\S\n]+/gu, " ")
    .trim();
}

function buildMemorySemanticKey(
  classification: Extract<MemoryCandidateClassification, { kind: "reviewable" }>,
) {
  if (classification.category === MemoryCategory.CONTACT_PREFERENCE) {
    // P0 stores one canonical communication-preference aggregate. A later
    // preference statement therefore replaces the prior aggregate instead of
    // leaving conflicting per-field memories simultaneously recallable.
    return "contact-preference:communication";
  }
  return [
    "representative-pattern",
    classification.category.toLowerCase(),
    classification.extractionReasonCode,
  ].join(":");
}

function normalizeClosedPreferenceKey(text: string): string {
  return text
    .toLocaleLowerCase("en-US")
    .replace(/[。.!！?？]\s*$/u, "")
    .trim();
}

function containsUnsafeMemoryContent(text: string): boolean {
  return promptInjectionPattern.test(text)
    || credentialPattern.test(text)
    || bareCredentialPattern.test(text)
    || transactionPattern.test(text)
    || currencyAmountPattern.test(text)
    || emailPattern.test(text)
    || phonePattern.test(text)
    || governmentIdPattern.test(text)
    || explicitIdentityFieldPattern.test(text)
    || healthOrDisabilityPattern.test(text)
    || religiousBeliefPattern.test(text)
    || raceOrEthnicityPattern.test(text)
    || politicalAffiliationPattern.test(text)
    || sexualOrientationOrGenderIdentityPattern.test(text)
    || biometricIdentifierPattern.test(text)
    || tradeUnionMembershipPattern.test(text)
    || commercialSecretPattern.test(text);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toRepresentativeChannelKind(
  channel: MemoryExtractionChannel,
): RepresentativeChannelKind {
  if (channel === "matrix") return RepresentativeChannelKind.MATRIX;
  if (channel === "telegram") return RepresentativeChannelKind.TELEGRAM;
  return RepresentativeChannelKind.WEB;
}

function parseMemoryExtractionChannel(
  value: string | null,
): MemoryExtractionChannel | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "web") return "web";
  if (normalized === "matrix") return "matrix";
  if (normalized === "telegram") return "telegram";
  return null;
}

function parseExtractionCoordinates(idempotencyKey: string): {
  scope: MemoryScope;
  channel: MemoryExtractionChannel;
  revisionDigest: string;
  trigger: MemoryExtractionTrigger;
} | null {
  const [prefix, version, trigger, scope, channel, revisionDigest, requestDigest] =
    idempotencyKey.split(":");
  if (
    prefix !== "memory-extraction"
    || !compatibleExtractionContractVersions.has(version ?? "")
  ) {
    return null;
  }
  if (scope !== MemoryScope.CONTACT_CHANNEL && scope !== MemoryScope.REPRESENTATIVE) {
    return null;
  }
  if (channel !== "web" && channel !== "matrix" && channel !== "telegram") {
    return null;
  }
  if (!revisionDigest || !/^[0-9a-f]{64}$/u.test(revisionDigest)) return null;
  if (!requestDigest || !/^[0-9a-f]{64}$/u.test(requestDigest)) return null;
  if (!Object.values(MemoryExtractionTrigger).includes(
    trigger as MemoryExtractionTrigger,
  )) {
    return null;
  }
  return {
    scope,
    channel,
    revisionDigest,
    trigger: trigger as MemoryExtractionTrigger,
  };
}

async function loadMemoryExtractionSource(
  tx: Prisma.TransactionClient,
  messageId: string,
): Promise<MemoryExtractionSource | null> {
  return tx.message.findUnique({
    where: { id: messageId },
    select: memoryExtractionSourceSelect,
  });
}

async function claimNextMemoryExtractionWork(): Promise<MemoryExtractionWorkClaim | null> {
  return claimMemoryExtractionWork();
}

async function claimMemoryExtractionRunById(
  runId: string,
): Promise<MemoryExtractionWorkClaim | null> {
  return claimMemoryExtractionWork(runId);
}

async function claimMemoryExtractionWork(
  runId?: string,
): Promise<MemoryExtractionWorkClaim | null> {
  const leaseToken = randomUUID();
  return runMemoryExtractionWriteTransaction(async (tx) => {
    const runFilter = runId
      ? Prisma.sql`AND extraction_run."id" = ${runId}`
      : Prisma.empty;
    const rows = await tx.$queryRaw<Array<{
      runId: string;
      leaseToken: string;
      attemptCount: number;
    }>>(Prisma.sql`
      WITH exhausted_candidate AS MATERIALIZED (
        SELECT extraction_run."id"
          FROM "MemoryExtractionRun" extraction_run
         WHERE extraction_run."attemptCount" >= ${maximumExtractionAttempts}
           AND (
             (
               extraction_run."status" = 'QUEUED'::"MemoryExtractionStatus"
               AND extraction_run."availableAt" <= CURRENT_TIMESTAMP
             )
             OR (
               extraction_run."status" = 'RUNNING'::"MemoryExtractionStatus"
               AND extraction_run."leaseExpiresAt" <= CURRENT_TIMESTAMP
             )
           )
           ${runFilter}
         ORDER BY extraction_run."availableAt" ASC,
                  extraction_run."createdAt" ASC,
                  extraction_run."id" ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 32
      ),
      exhausted_runs AS (
        UPDATE "MemoryExtractionRun" extraction_run
           SET "status" = 'FAILED'::"MemoryExtractionStatus",
               "leaseToken" = NULL,
               "leaseExpiresAt" = NULL,
               "startedAt" = COALESCE(
                 extraction_run."startedAt",
                 CURRENT_TIMESTAMP
               ),
               "finishedAt" = CURRENT_TIMESTAMP,
               "errorCode" = 'memory_extraction_attempts_exhausted',
               "updatedAt" = CURRENT_TIMESTAMP
          FROM exhausted_candidate
         WHERE extraction_run."id" = exhausted_candidate."id"
        RETURNING extraction_run."id"
      ),
      next_run AS MATERIALIZED (
        SELECT extraction_run."id"
          FROM "MemoryExtractionRun" extraction_run
         WHERE extraction_run."attemptCount" < ${maximumExtractionAttempts}
           AND (
             (
               extraction_run."status" = 'QUEUED'::"MemoryExtractionStatus"
               AND extraction_run."availableAt" <= CURRENT_TIMESTAMP
             )
             OR (
               extraction_run."status" = 'RUNNING'::"MemoryExtractionStatus"
               AND extraction_run."leaseExpiresAt" <= CURRENT_TIMESTAMP
             )
           )
           ${runFilter}
         ORDER BY extraction_run."availableAt" ASC,
                  extraction_run."createdAt" ASC,
                  extraction_run."id" ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      UPDATE "MemoryExtractionRun" extraction_run
         SET "status" = 'RUNNING'::"MemoryExtractionStatus",
             "leaseToken" = ${leaseToken},
             "leaseExpiresAt" = CURRENT_TIMESTAMP
               + (${extractionLeaseMilliseconds} * INTERVAL '1 millisecond'),
             "startedAt" = COALESCE(
               extraction_run."startedAt",
               CURRENT_TIMESTAMP
             ),
             "finishedAt" = NULL,
             "errorCode" = NULL,
             "attemptCount" = extraction_run."attemptCount" + 1,
             "updatedAt" = CURRENT_TIMESTAMP
        FROM next_run
       WHERE extraction_run."id" = next_run."id"
      RETURNING extraction_run."id" AS "runId",
                extraction_run."leaseToken" AS "leaseToken",
                extraction_run."attemptCount" AS "attemptCount"
    `);
    return rows[0] ?? null;
  });
}

export function resolveMemoryExtractionRetryDelayMilliseconds(
  attemptCount: number,
): number {
  const normalizedAttempt = Math.max(1, Math.trunc(attemptCount));
  return Math.min(
    extractionRetryMaximumMilliseconds,
    extractionRetryBaseMilliseconds * (2 ** (normalizedAttempt - 1)),
  );
}

async function recordMemoryExtractionFailure(
  claim: MemoryExtractionWorkClaim,
  errorCode: string,
): Promise<MemoryExtractionFailureResult> {
  const failed = claim.attemptCount >= maximumExtractionAttempts;
  const now = new Date();
  const availableAt = new Date(
    now.getTime()
      + resolveMemoryExtractionRetryDelayMilliseconds(claim.attemptCount),
  );
  const updated = await runMemoryExtractionWriteTransaction((tx) =>
    tx.memoryExtractionRun.updateMany({
      where: {
        id: claim.runId,
        status: MemoryExtractionStatus.RUNNING,
        leaseToken: claim.leaseToken,
        attemptCount: claim.attemptCount,
      },
      data: failed
        ? {
            status: MemoryExtractionStatus.FAILED,
            leaseToken: null,
            leaseExpiresAt: null,
            finishedAt: now,
            errorCode,
          }
        : {
            status: MemoryExtractionStatus.QUEUED,
            leaseToken: null,
            leaseExpiresAt: null,
            availableAt,
            finishedAt: null,
            errorCode,
          },
    }),
  );
  if (updated.count !== 1) {
    return { status: "lease_lost", attemptCount: claim.attemptCount };
  }
  return failed
    ? { status: "failed", attemptCount: claim.attemptCount }
    : { status: "retrying", availableAt, attemptCount: claim.attemptCount };
}

async function cancelMemoryExtractionRun(
  tx: Prisma.TransactionClient,
  runId: string,
  errorCode: string,
  finishedAt: Date,
  expectedLeaseToken?: string,
) {
  const canceledQueued = await tx.memoryExtractionRun.updateMany({
    where: {
      id: runId,
      status: MemoryExtractionStatus.QUEUED,
      ...(expectedLeaseToken ? { leaseToken: expectedLeaseToken } : {}),
    },
    data: {
      status: MemoryExtractionStatus.CANCELED,
      leaseToken: null,
      leaseExpiresAt: null,
      startedAt: finishedAt,
      finishedAt,
      errorCode,
    },
  });
  const canceledRunning = await tx.memoryExtractionRun.updateMany({
    where: {
      id: runId,
      status: MemoryExtractionStatus.RUNNING,
      ...(expectedLeaseToken ? { leaseToken: expectedLeaseToken } : {}),
    },
    data: {
      status: MemoryExtractionStatus.CANCELED,
      leaseToken: null,
      leaseExpiresAt: null,
      finishedAt,
      errorCode,
    },
  });
  return {
    processed: canceledQueued.count + canceledRunning.count === 1,
    runId,
    status:
      canceledQueued.count + canceledRunning.count === 1
        ? MemoryExtractionStatus.CANCELED
        : "LEASE_LOST",
    reasonCode: errorCode,
  };
}

function runMemoryExtractionWriteTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return runWithPrismaWriteConflictRetry(
    () => prisma.$transaction(
      operation,
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
    { additionalRetryableCodes: ["P2002"] },
  );
}

function hasMemoryExtractionStorage(tx: Prisma.TransactionClient): boolean {
  const candidate = tx as unknown as Record<string, unknown>;
  return hasDelegateMethod(candidate["message"], "findUnique")
    && hasDelegateMethod(candidate["representativeMemoryPolicy"], "findUnique")
    && hasDelegateMethod(candidate["memoryExtractionRun"], "findUnique")
    && hasDelegateMethod(candidate["memoryExtractionRun"], "create");
}

function hasMemoryInvalidationStorage(tx: Prisma.TransactionClient): boolean {
  const candidate = tx as unknown as Record<string, unknown>;
  return hasDelegateMethod(candidate["memoryExtractionRun"], "updateMany")
    && hasDelegateMethod(candidate["memoryCandidate"], "findMany")
    && hasDelegateMethod(candidate["memoryCandidate"], "update");
}

function hasGovernedMemoryInvalidationStorage(
  tx: Prisma.TransactionClient,
): boolean {
  const candidate = tx as unknown as Record<string, unknown>;
  return hasDelegateMethod(candidate["governedMemory"], "findMany")
    && hasDelegateMethod(candidate["governedMemory"], "updateMany")
    && hasDelegateMethod(candidate["memoryProjectionItem"], "updateMany");
}

async function queueInvalidatedMemoryProjectionCleanup(
  tx: Prisma.TransactionClient,
  memoryIds: string[],
  occurredAt: Date,
) {
  await tx.memoryProjectionItem.updateMany({
    where: {
      memoryId: { in: memoryIds },
      status: MemoryProjectionStatus.PROJECTING,
    },
    data: { deleteRequestedAt: occurredAt },
  });
  await tx.memoryProjectionItem.updateMany({
    where: {
      memoryId: { in: memoryIds },
      status: {
        in: [
          MemoryProjectionStatus.DISABLED,
          MemoryProjectionStatus.QUEUED,
          MemoryProjectionStatus.RETRYING,
          MemoryProjectionStatus.STAGED,
          MemoryProjectionStatus.ACTIVE,
          MemoryProjectionStatus.SUPERSEDED,
          MemoryProjectionStatus.FAILED,
          MemoryProjectionStatus.DELETE_FAILED,
        ],
      },
    },
    data: {
      status: MemoryProjectionStatus.DELETE_PENDING,
      deleteRequestedAt: occurredAt,
      availableAt: occurredAt,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
    },
  });
}

function hasDelegateMethod(value: unknown, method: string): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as Record<string, unknown>)[method] === "function",
  );
}

const memoryExtractionPolicySelect = {
  longTermMemoryEnabled: true,
  contactMemoryEnabled: true,
  contactMemoryCrossChannelEnabled: true,
  representativeExperienceEnabled: true,
  autoExtract: true,
  webExtractEnabled: true,
  matrixExtractEnabled: true,
  telegramExtractEnabled: true,
  retentionDays: true,
  revision: true,
} as const;

const memoryExtractionSourceSelect = {
  id: true,
  conversationId: true,
  channelBindingId: true,
  channelLifecycleRevision: true,
  createdAt: true,
  ingressSequence: true,
  memoryIngressOrdinal: true,
  senderType: true,
  contentType: true,
  text: true,
  editedAt: true,
  redactedAt: true,
  conversation: {
    select: {
      representativeId: true,
      contactId: true,
      sourceChannel: true,
    },
  },
} as const;
