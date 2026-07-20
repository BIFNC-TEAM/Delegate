import { z } from "zod";

const matrixBridgeConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  homeserverToken: z.string().min(24),
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

  return matrixBridgeConfigSchema.parse({
    port: Number(env.MATRIX_BRIDGE_PORT || 4030),
    homeserverToken,
    maxBodyBytes: Number(env.MATRIX_BRIDGE_MAX_BODY_BYTES || 2 * 1024 * 1024),
  });
}
