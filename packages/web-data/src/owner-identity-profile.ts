import { createLogtoManagementClient, readLogtoManagementConfig } from "./logto-management";
import { prisma } from "./prisma";
import { readLogtoAccountCenterUrl } from "./owner-settings";

export type OwnerIdentityProfile = {
  avatar: string | null;
  phone: string | null;
  email: string | null;
  hasPassword: boolean;
  wechatLinked: boolean;
  links: { phone: string; password: string; social: string } | null;
};
export type IdentityProfilePrincipal = { ownerId: string; issuer: string; subject: string };
export class IdentityProfileError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function safeAvatar(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null; } catch { return null; }
}
export function serializeIdentityProfile(user: Record<string, unknown>, managementUrl: string | null): OwnerIdentityProfile {
  const identities = user.identities && typeof user.identities === "object" && !Array.isArray(user.identities) ? user.identities as Record<string, unknown> : {};
  const center = managementUrl ? new URL(managementUrl) : null;
  return {
    avatar: safeAvatar(user.avatar),
    phone: typeof user.primaryPhone === "string" && user.primaryPhone ? user.primaryPhone : null,
    email: typeof user.primaryEmail === "string" && user.primaryEmail ? user.primaryEmail : null,
    hasPassword: user.hasPassword === true,
    wechatLinked: Boolean(identities.wechat),
    links: center ? {
      phone: new URL('/account/phone', center.origin).toString(),
      password: new URL('/account/password', center.origin).toString(),
      social: new URL('/account/security', center.origin).toString(),
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
  const user = await client.getUserProfile(principal.subject);
  if (user.isSuspended === true) throw new IdentityProfileError(403, "Account is unavailable.");
  return serializeIdentityProfile(user, readLogtoAccountCenterUrl());
}
export async function updateOwnerAvatar(principal: IdentityProfilePrincipal, avatar: unknown) {
  if (typeof avatar !== 'string' || avatar.length > 2048 || (avatar !== '' && !safeAvatar(avatar))) throw new IdentityProfileError(400, "Use a valid HTTPS avatar URL (up to 2048 characters).");
  const client = await clientFor(principal);
  const current = await client.getUserProfile(principal.subject);
  if (current.isSuspended === true) throw new IdentityProfileError(403, "Account is unavailable.");
  await client.updateUserAvatar(principal.subject, avatar);
  const saved = await client.getUserProfile(principal.subject);
  if ((saved.avatar || '') !== avatar) throw new IdentityProfileError(502, "Avatar update could not be verified.");
  return serializeIdentityProfile(saved, readLogtoAccountCenterUrl());
}
