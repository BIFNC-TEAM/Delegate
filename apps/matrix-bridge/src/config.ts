import { z } from "zod";

const matrixBridgeConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  homeserverToken: z.string().min(24),
  homeserverUrl: z.string().url().optional(),
  applicationServiceToken: z.string().min(24).optional(),
  serverName: z.string()
    .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9]\d{0,4})?$/)
    .optional(),
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
  const homeserverUrl = env.MATRIX_HOMESERVER_URL?.trim() || undefined;
  const applicationServiceToken = env.MATRIX_AS_TOKEN?.trim() || undefined;
  const serverName = env.MATRIX_SERVER_NAME?.trim().toLowerCase() || undefined;
  if (Boolean(homeserverUrl) !== Boolean(applicationServiceToken)) {
    throw new Error(
      "MATRIX_HOMESERVER_URL and MATRIX_AS_TOKEN must be configured together for managed room joins.",
    );
  }
  if (homeserverUrl && !serverName) {
    throw new Error(
      "MATRIX_SERVER_NAME is required with outbound homeserver configuration.",
    );
  }

  return matrixBridgeConfigSchema.parse({
    port: Number(env.MATRIX_BRIDGE_PORT || 4030),
    homeserverToken,
    ...(homeserverUrl ? { homeserverUrl } : {}),
    ...(applicationServiceToken ? { applicationServiceToken } : {}),
    ...(serverName ? { serverName } : {}),
    maxBodyBytes: Number(env.MATRIX_BRIDGE_MAX_BODY_BYTES || 2 * 1024 * 1024),
  });
}
