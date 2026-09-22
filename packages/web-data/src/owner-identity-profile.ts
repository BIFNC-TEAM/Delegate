import { AvatarUploadError, MAX_AVATAR_FILE_BYTES, managedAvatarObjectKey, storeOwnerAvatar, deleteOwnerAvatarObject } from "./owner-avatar-storage";
import { createLogtoManagementClient, readLogtoManagementConfig, type AccountSocialConnector } from "./logto-management";
import { prisma } from "./prisma";
import { readLogtoAccountCenterUrl } from "./owner-settings";

export type OwnerIdentityProfile = {
  avatar: string | null;
  avatarCleanupPending?: boolean;
  phone: string | null;
  email: string | null;
  hasPassword: boolean;
  wechatLinked: boolean;
  socialAccounts: { provider: string; name: AccountSocialConnector['name']; linked: boolean; actions: { bind: string; change: string; remove: string } | null }[];
  links: { phone: string; email: string | null; password: string; social: string } | null;
};
export type IdentityProfilePrincipal = { ownerId: string; issuer: string; subject: string };
export class IdentityProfileError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function safeAvatar(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try { const url = new URL(value); return (url.protocol === "https:" || managedAvatarObjectKey(value)) && !url.username && !url.password ? url.toString() : null; } catch { return null; }
}
export function serializeIdentityProfile(user: Record<string, unknown>, managementUrl: string | null, emailBindingAvailable = false, connectors: AccountSocialConnector[] = []): OwnerIdentityProfile {
  const identities = user.identities && typeof user.identities === "object" && !Array.isArray(user.identities) ? user.identities as Record<string, unknown> : {};
  const center = managementUrl ? new URL(managementUrl) : null;
  return {
    avatar: safeAvatar(user.avatar),
    phone: typeof user.primaryPhone === "string" && user.primaryPhone ? user.primaryPhone : null,
    email: typeof user.primaryEmail === "string" && user.primaryEmail ? user.primaryEmail : null,
    hasPassword: user.hasPassword === true,
    wechatLinked: Boolean(identities.wechat),
    socialAccounts: connectors.map((connector) => ({
      provider: connector.target, name: connector.name, linked: Boolean(identities[connector.target]),
      actions: center && connector.editable ? {
        bind: new URL(`/account/social/${encodeURIComponent(connector.id)}`, center.origin).toString(),
        change: new URL(`/account/social/${encodeURIComponent(connector.id)}/change`, center.origin).toString(),
        remove: new URL(`/account/social/${encodeURIComponent(connector.id)}/remove`, center.origin).toString(),
      } : null,
    })),
    links: center ? {
      phone: new URL('/account/phone', center.origin).toString(),
      email: emailBindingAvailable ? new URL('/account/email', center.origin).toString() : null,
      password: new URL('/account/password', center.origin).toString(),
      social: '/dashboard?view=settings&settingsSection=profile#account-social-heading',
    } : null,
  };
}
async function clientFor(principal: IdentityProfilePrincipal) {
  const endpoint = process.env.LOGTO_ENDPOINT?.trim();
  if (!endpoint || principal.issuer !== new URL('/oidc', endpoint).toString()) throw new IdentityProfileError(403, "Identity issuer mismatch.");
  const link = await prisma.ownerIdentityLink.findFirst({ where: { ownerId: principal.ownerId, provider: 'LOGTO', issuer: principal.issuer, providerSubject: principal.subject }, select: { id: true } });
  if (!link) throw new IdentityProfileError(403, "Identity is not linked to this Owner.");
  const config = readLogtoManagementConfig();
  if (!config) throw new IdentityProfileError(503, "Account profile is unavailable.");
  return createLogtoManagementClient(config);
}
export async function getOwnerIdentityProfile(principal: IdentityProfilePrincipal) {
  const client = await clientFor(principal);
  const [user, capabilities] = await Promise.all([client.getUserProfile(principal.subject), client.getAccountBindingCapabilities()]);
  if (user.isSuspended === true) throw new IdentityProfileError(403, "Account is unavailable.");
  return serializeIdentityProfile(user, readLogtoAccountCenterUrl(), capabilities.emailEnabled, capabilities.socialConnectors);
}
export async function updateOwnerAvatar(principal: IdentityProfilePrincipal, avatar: unknown) {
  if (typeof avatar !== 'string' || avatar.length > 2048 || (avatar !== '' && !safeAvatar(avatar))) throw new IdentityProfileError(400, "Use a valid HTTPS avatar URL (up to 2048 characters).");
  const client = await clientFor(principal);
  const [current, capabilities] = await Promise.all([client.getUserProfile(principal.subject), client.getAccountBindingCapabilities()]);
  if (current.isSuspended === true) throw new IdentityProfileError(403, "Account is unavailable.");
  await client.updateUserAvatar(principal.subject, avatar);
  const saved = await client.getUserProfile(principal.subject);
  if ((saved.avatar || '') !== avatar) throw new IdentityProfileError(502, "Avatar update could not be verified.");
  const oldKey = avatar === '' && typeof current.avatar === 'string' ? managedAvatarObjectKey(current.avatar, principal.ownerId) : null;
  const cleanupPending = oldKey ? !await cleanupAvatar(oldKey) : false;
  return { ...serializeIdentityProfile(saved, readLogtoAccountCenterUrl(), capabilities.emailEnabled, capabilities.socialConnectors), ...(cleanupPending ? { avatarCleanupPending: true } : {}) };
}

async function cleanupAvatar(key: string): Promise<boolean> {
  try { await deleteOwnerAvatarObject(key); return true; }
  catch { console.warn("owner_avatar_cleanup_failed", { objectKey: key }); return false; }
}
export async function uploadOwnerAvatar(principal: IdentityProfilePrincipal, input: unknown) {
  if (!input || typeof input !== "object" || !("base64" in input) || typeof input.base64 !== "string"
    || Object.keys(input).some((key) => key !== "base64") || input.base64.length > Math.ceil(MAX_AVATAR_FILE_BYTES / 3) * 4
    ) throw new IdentityProfileError(400, "Invalid avatar upload.");
  const bytes = Buffer.from(input.base64, "base64");
  if (bytes.toString("base64") !== input.base64) throw new IdentityProfileError(400, "Invalid avatar encoding.");
  const client = await clientFor(principal);
  const [current, capabilities] = await Promise.all([client.getUserProfile(principal.subject), client.getAccountBindingCapabilities()]);
  if (current.isSuspended === true) throw new IdentityProfileError(403, "Account is unavailable.");
  let stored;
  try { stored = await storeOwnerAvatar(principal.ownerId, bytes); }
  catch (error) { if (error instanceof AvatarUploadError) throw new IdentityProfileError(error.status, error.message); throw error; }
  let saved;
  try {
    await client.updateUserAvatar(principal.subject, stored.url);
    saved = await client.getUserProfile(principal.subject);
    if (saved.avatar !== stored.url) throw new Error("Avatar update was not confirmed.");
  } catch (error) {
    // A lost response may still mean a committed update. Only delete our new
    // object when a fresh read proves it is not referenced; never break a saved avatar.
    let latest;
    try { latest = await client.getUserProfile(principal.subject); }
    catch { console.warn("owner_avatar_confirmation_unavailable", { objectKey: stored.key }); }
    if (latest?.avatar === stored.url) saved = latest;
    else {
      if (latest) await cleanupAvatar(stored.key);
      throw new IdentityProfileError(502, "Avatar save could not be confirmed. Refresh your profile before retrying.");
    }
  }
  const oldKey = typeof current.avatar === "string" ? managedAvatarObjectKey(current.avatar, principal.ownerId) : null;
  const cleanupPending = oldKey && oldKey !== stored.key ? !await cleanupAvatar(oldKey) : false;
  return { ...serializeIdentityProfile(saved, readLogtoAccountCenterUrl(), capabilities.emailEnabled, capabilities.socialConnectors), ...(cleanupPending ? { avatarCleanupPending: true } : {}) };
}
