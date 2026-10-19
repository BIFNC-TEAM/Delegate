import type {
  CapabilityKind,
  CapabilityPolicyProfile,
  ContactComputeTrustTier,
  CapabilityPolicyRule,
  PolicyChannel,
  PolicyDecision,
  PolicyResourceScope,
} from "@delegate/compute-protocol";

export type EvaluateCapabilityRequest = {
  capability: CapabilityKind;
  command?: string | undefined;
  path?: string | undefined;
  domain?: string | undefined;
  resourceScope?: PolicyResourceScope | undefined;
  channel?: PolicyChannel | undefined;
  estimatedTokens?: number | undefined;
  contactTrustTier?: ContactComputeTrustTier | undefined;
  customerAccountId?: string | undefined;
};

export type EvaluatedCapabilityDecision = {
  decision: PolicyDecision;
  reason: string;
  matchedRuleId?: string;
};

export function evaluateCapabilityPolicy(
  profile: CapabilityPolicyProfile,
  request: EvaluateCapabilityRequest,
): EvaluatedCapabilityDecision {
  const matched = evaluateCapabilityPolicyRules(profile, request);
  if (matched) {
    return matched;
  }

  return {
    decision: profile.defaultDecision,
    reason: "default_profile_decision",
  };
}

export function evaluateCapabilityPolicyStack(
  profiles: CapabilityPolicyProfile[],
  request: EvaluateCapabilityRequest,
): EvaluatedCapabilityDecision {
  if (!profiles.length) {
    return {
      decision: "ask",
      reason: "missing_policy_profiles",
    };
  }

  const overlays = profiles.filter(
    (profile) =>
      profile.isManaged &&
      profile.enabled &&
      matchesManagedProfile(profile, request),
  );
  const baseProfile =
    profiles.find((profile) => !profile.isManaged && profile.isDefault) ??
    profiles.find((profile) => !profile.isManaged) ??
    profiles[profiles.length - 1]!;

  for (const profile of overlays.sort((left, right) => right.precedence - left.precedence)) {
    const matched = evaluateCapabilityPolicyRules(profile, request);
    if (matched) {
      return {
        ...matched,
        reason: `managed_${matched.reason}`,
      };
    }
  }

  return evaluateCapabilityPolicy(baseProfile, request);
}

function evaluateCapabilityPolicyRules(
  profile: CapabilityPolicyProfile,
  request: EvaluateCapabilityRequest,
): EvaluatedCapabilityDecision | null {
  const sortedRules = [...profile.rules].sort((left, right) => right.priority - left.priority);

  for (const rule of sortedRules) {
    // This exact membership-era built-in was generated independently of the
    // Owner's browser setting. Do not revive it from old stored profiles.
    if (isRetiredDefaultBrowserApproval(profile, rule)) continue;
    if (rule.capability !== request.capability) {
      continue;
    }

    if (!matchesPattern(rule.commandPattern, request.command)) {
      continue;
    }

    if (!matchesPattern(rule.pathPattern, request.path)) {
      continue;
    }

    if (!matchesPattern(rule.domainPattern, request.domain)) {
      continue;
    }

    if (rule.resourceScopeCondition && request.resourceScope !== rule.resourceScopeCondition) {
      continue;
    }

    if (rule.channelCondition && request.channel !== rule.channelCondition) {
      continue;
    }

    // Consumption quota is authorized and reserved by the broker before this
    // policy layer runs. Retired membership fields must never gate capabilities.

    if (
      typeof rule.maxEstimatedTokens === "number" &&
      typeof request.estimatedTokens === "number" &&
      request.estimatedTokens > rule.maxEstimatedTokens
    ) {
      return {
        decision: "ask",
        reason: "tokens_above_rule_limit",
        matchedRuleId: rule.id,
      };
    }

    if (rule.requiresHumanApproval) {
      return {
        decision: "ask",
        reason: "human_approval_required",
        matchedRuleId: rule.id,
      };
    }

    return {
      decision: rule.decision,
      reason: "matched_rule",
      matchedRuleId: rule.id,
    };
  }

  return null;
}

function isRetiredDefaultBrowserApproval(profile: CapabilityPolicyProfile, rule: CapabilityPolicyRule): boolean {
  return profile.isManaged && profile.managedScope === "delegate_managed"
    && profile.managedSource === "delegate-default" && profile.precedence === 100 && !profile.editableByOwner
    && profile.id === `cap_profile_managed_${profile.representativeId}`
    && !profile.ownerId && !profile.organizationId && !profile.customerAccountId && !profile.contactTrustTierCondition
    && rule.id === `${profile.id}_browser_paid_private` && rule.capability === "browser"
    && rule.decision === "ask" && rule.requiresHumanApproval && rule.priority === 220
    && rule.domainPattern === ".*" && rule.resourceScopeCondition === "browser_lane" && rule.channelCondition === "private_chat"
    && !rule.commandPattern && !rule.pathPattern && rule.maxEstimatedTokens === undefined;
}

function matchesManagedProfile(
  profile: CapabilityPolicyProfile,
  request: EvaluateCapabilityRequest,
): boolean {
  if (profile.customerAccountId && request.customerAccountId !== profile.customerAccountId) {
    return false;
  }

  if (!profile.contactTrustTierCondition) {
    return true;
  }

  return request.contactTrustTier === profile.contactTrustTierCondition;
}

function matchesPattern(pattern: string | undefined, value: string | undefined): boolean {
  if (!pattern) {
    return true;
  }

  if (!value) {
    return false;
  }

  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return value.includes(pattern);
  }
}
