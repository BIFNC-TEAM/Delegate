import {
  isAudienceAuthSessionRotationRequiredError,
  linkAudienceIdentityToAuth,
  resolveWebAudienceContact,
  type ExternalAuthProfile,
} from "@delegate/web-data";

import {
  createPublicChatSessionState,
  type PublicChatSessionState,
} from "./public-chat";

type PublicAudienceAuthBindingDependencies = {
  linkAudienceIdentityToAuth: typeof linkAudienceIdentityToAuth;
  resolveWebAudienceContact: typeof resolveWebAudienceContact;
  createPublicChatSessionState: typeof createPublicChatSessionState;
};

const defaultDependencies: PublicAudienceAuthBindingDependencies = {
  linkAudienceIdentityToAuth,
  resolveWebAudienceContact,
  createPublicChatSessionState,
};

/**
 * Binds a verified subject to the browser's current anonymous audience.
 *
 * If the browser is already attached to a different registered identity, the
 * resolver deliberately refuses the implicit link. In that case, rotate to a
 * fresh anonymous chat identity and retry so account switching cannot merge or
 * cross-link the two registered accounts.
 */
export async function bindPublicAudienceAuthProfile(
  input: {
    representativeId: string;
    representativeSlug: string;
    initialAudienceIdentityId: string;
    sessionState: PublicChatSessionState;
    profile: ExternalAuthProfile;
    now?: Date;
  },
  dependencies: PublicAudienceAuthBindingDependencies = defaultDependencies,
): Promise<{
  audienceIdentityId: string;
  sessionState: PublicChatSessionState;
  rotated: boolean;
}> {
  try {
    const audienceIdentity = await dependencies.linkAudienceIdentityToAuth({
      audienceIdentityId: input.initialAudienceIdentityId,
      profile: input.profile,
      ...(input.now ? { now: input.now } : {}),
    });
    return {
      audienceIdentityId: audienceIdentity.id,
      sessionState: input.sessionState,
      rotated: false,
    };
  } catch (error) {
    if (!isAudienceAuthSessionRotationRequiredError(error)) {
      throw error;
    }
  }

  const rotatedSessionState = dependencies.createPublicChatSessionState({
    ...(input.now ? { now: input.now } : {}),
  });
  const rotatedContact = await dependencies.resolveWebAudienceContact({
    representativeId: input.representativeId,
    representativeSlug: input.representativeSlug,
    audienceId: rotatedSessionState.audienceId,
    ...(input.now ? { now: input.now } : {}),
  });
  if (!rotatedContact.audienceIdentityId) {
    throw new Error(
      "Audience identity is required after rotating the browser session.",
    );
  }

  const audienceIdentity = await dependencies.linkAudienceIdentityToAuth({
    audienceIdentityId: rotatedContact.audienceIdentityId,
    profile: input.profile,
    ...(input.now ? { now: input.now } : {}),
  });
  return {
    audienceIdentityId: audienceIdentity.id,
    sessionState: rotatedSessionState,
    rotated: true,
  };
}
