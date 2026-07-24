import { applyRuntimePolicyOverlays } from "@delegate/runtime";

export type CanonicalChannelKind = "web" | "matrix" | "telegram";

export type ChannelAvailabilityCode =
  | "available"
  | "representative_paused"
  | "representative_unpublished"
  | "representative_archived"
  | "public_web_disabled"
  | "channel_not_connected"
  | "channel_paused"
  | "channel_disconnected"
  | "channel_unhealthy"
  | "matrix_private_room_not_verified"
  | "policy_disabled";

export type ChannelAvailabilityResult =
  | { available: true; code: "available" }
  | { available: false; code: Exclude<ChannelAvailabilityCode, "available"> };

export type ChannelAvailabilityInput = {
  channel: CanonicalChannelKind;
  lifecycleState: string;
  activeVersionId: string | null;
  publicMode: boolean;
  binding?: {
    legacyStatus?: string | null;
    desiredState?: string | null;
    healthStatus?: string | null;
  } | null;
  overlays?: Array<{
    enabled: boolean;
    priority: number;
    startsAt: Date;
    expiresAt?: Date | null;
    payload: Record<string, unknown>;
  }>;
  now?: Date;
};

/**
 * One policy gate shared by public Web, native Matrix, Telegram, and bridged
 * Telegram. Historical representative versions never override these live
 * safety controls.
 */
export function resolveChannelAvailability(
  input: ChannelAvailabilityInput,
): ChannelAvailabilityResult {
  const lifecycle = input.lifecycleState.trim().toUpperCase();
  if (lifecycle === "ARCHIVED") {
    return { available: false, code: "representative_archived" };
  }
  if (lifecycle === "PAUSED") {
    return { available: false, code: "representative_paused" };
  }
  if (lifecycle !== "PUBLISHED" || !input.activeVersionId) {
    return { available: false, code: "representative_unpublished" };
  }

  const policy = applyRuntimePolicyOverlays(
    {
      publicMode: input.publicMode,
      channels: {
        [input.channel]: {
          enabled: true,
          paused: false,
        },
      },
    },
    input.overlays ?? [],
    input.now ?? new Date(),
  );
  const channelPolicy = readChannelPolicy(policy, input.channel);
  if (channelPolicy.paused || channelPolicy.enabled === false) {
    return { available: false, code: "policy_disabled" };
  }
  if (input.channel === "web" && policy.publicMode === false) {
    return { available: false, code: "public_web_disabled" };
  }

  if (!input.binding) {
    return { available: false, code: "channel_not_connected" };
  }
  const desiredState = input.binding.desiredState?.trim().toUpperCase();
  if (desiredState === "PAUSED") {
    return { available: false, code: "channel_paused" };
  }
  if (desiredState === "DISCONNECTED") {
    return { available: false, code: "channel_disconnected" };
  }

  const legacyStatus = input.binding.legacyStatus?.trim().toUpperCase();
  if (
    !desiredState &&
    legacyStatus &&
    !["CONNECTED", "ACTIVE", "HEALTHY", "DEGRADED"].includes(legacyStatus)
  ) {
    return {
      available: false,
      code: legacyStatus === "PAUSED" ? "channel_paused" : "channel_disconnected",
    };
  }

  const healthStatus = input.binding.healthStatus?.trim().toUpperCase();
  if (healthStatus === "UNHEALTHY") {
    return { available: false, code: "channel_unhealthy" };
  }

  return { available: true, code: "available" };
}

export function assertChannelAvailable(input: ChannelAvailabilityInput): void {
  const result = resolveChannelAvailability(input);
  if (!result.available) {
    throw new ChannelUnavailableError(result.code);
  }
}

export class ChannelUnavailableError extends Error {
  readonly code: Exclude<ChannelAvailabilityCode, "available">;

  constructor(code: Exclude<ChannelAvailabilityCode, "available">) {
    super(`Channel is unavailable: ${code}.`);
    this.name = "ChannelUnavailableError";
    this.code = code;
  }
}

function readChannelPolicy(
  policy: Record<string, unknown>,
  channel: CanonicalChannelKind,
): { enabled?: boolean; paused?: boolean } {
  const channels = isRecord(policy.channels) ? policy.channels : {};
  const channelValue = isRecord(channels[channel]) ? channels[channel] : {};
  return {
    ...(typeof channelValue.enabled === "boolean"
      ? { enabled: channelValue.enabled }
      : {}),
    ...(typeof channelValue.paused === "boolean"
      ? { paused: channelValue.paused }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
