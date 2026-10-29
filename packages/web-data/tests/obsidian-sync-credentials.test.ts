import { afterEach, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { seal, unseal } from "../src/obsidian-sync/credentials";

afterEach(() => vi.unstubAllEnvs());
it("encrypts credentials and binds them to both owner and connection", () => {
  vi.stubEnv("OBSIDIAN_SYNC_CREDENTIAL_KEY", randomBytes(32).toString("base64"));
  const secret = { token: "secret-token", vaults: { test: { key: "secret-key" } } };
  const ciphertext = seal(secret, "owner-a", "connection-a");
  expect(ciphertext).not.toContain("secret-token");
  expect(unseal(ciphertext, "owner-a", "connection-a")).toEqual(secret);
  expect(() => unseal(ciphertext, "owner-b", "connection-a")).toThrow();
  expect(() => unseal(ciphertext, "owner-a", "connection-b")).toThrow();
  expect(seal(secret, "owner-a", "connection-a")).not.toBe(ciphertext);
});
it("fails closed without a configured master key", () => {
  vi.stubEnv("OBSIDIAN_SYNC_CREDENTIAL_KEY", "");
  expect(() => seal({}, "a", "b")).toThrow("UNAVAILABLE");
});
