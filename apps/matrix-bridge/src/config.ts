import { z } from "zod";

import { isValidMatrixServerName } from "@delegate/web-data";

const matrixBridgeConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  homeserverToken: z.string().min(24),
  homeserverUrl: z.string().url(),
  applicationServiceToken: z.string().min(24),
  serverName: z.string().refine(isValidMatrixServerName),
  senderLocalpart: z.string().regex(/^[a-z0-9._=-]+$/),
  maxBodyBytes: z.number().int().min(1024).max(10 * 1024 * 1024),
});

export type MatrixBridgeConfig = z.infer<typeof matrixBridgeConfigSchema>;

export function resolveMatrixBridgeConfig(
  env: Record<string, string | undefined> = process.env,
): MatrixBridgeConfig {
  const homeserverToken = env.MATRIX_AS_HS_TOKEN?.trim();
  if (!homeserverToken) {
    throw new Error("MATRIX_AS_HS_TOKEN is required. Store it in environment secrets, never in source code.");
  }
  const homeserverUrl = env.MATRIX_HOMESERVER_URL?.trim();
  const applicationServiceToken = env.MATRIX_AS_TOKEN?.trim();
  const serverName = env.MATRIX_SERVER_NAME?.trim();
  if (!homeserverUrl || !applicationServiceToken) {
    throw new Error(
      "MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN are required for the Matrix Application Service.",
    );
  }
  if (!serverName) {
    throw new Error(
      "MATRIX_SERVER_NAME is required for managed Matrix users.",
    );
  }

  return matrixBridgeConfigSchema.parse({
    port: Number(env.MATRIX_BRIDGE_PORT || 4030),
    homeserverToken,
    homeserverUrl,
    applicationServiceToken,
    serverName,
    senderLocalpart: env.MATRIX_AS_SENDER_LOCALPART?.trim() || "_delegate_as",
    maxBodyBytes: Number(env.MATRIX_BRIDGE_MAX_BODY_BYTES || 2 * 1024 * 1024),
  });
}
