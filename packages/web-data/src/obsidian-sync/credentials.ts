import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SyncError } from "@delegate/obsidian-sync";

function key() {
  const value = Buffer.from(process.env.OBSIDIAN_SYNC_CREDENTIAL_KEY ?? "", "base64");
  if (value.length !== 32) throw new SyncError("UNAVAILABLE");
  return value;
}
export function assertCredentialKey() { key(); }

export function seal(value: unknown, ownerId: string, connectionId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(`obsidian-sync:v1:${ownerId}:${connectionId}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}
export function unseal<T>(value: string, ownerId: string, connectionId: string): T {
  try {
    const [version, iv, tag, ciphertext] = value.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Invalid credential");
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(`obsidian-sync:v1:${ownerId}:${connectionId}`));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8")) as T;
  } catch { throw new SyncError("UNAVAILABLE"); }
}
