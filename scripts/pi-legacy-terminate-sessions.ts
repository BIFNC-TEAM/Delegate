import { createHash } from "node:crypto";

import { PrismaClient } from "@prisma/client";

function requiredFlag(name: string) {
  const value = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (!value) throw new Error(`${name} is required`);
  return value.slice(name.length + 1);
}

function databaseFingerprint(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const protocol = url.protocol.replace(/:$/u, "").toLowerCase();
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const port = url.port || "5432";
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  return createHash("sha256")
    .update([protocol, host, port, database].join("|"))
    .digest("hex")
    .slice(0, 16);
}

async function main() {
  if (!process.argv.includes("--apply") || !process.argv.includes("--maintenance-confirmed")) {
    throw new Error("--apply and --maintenance-confirmed are required");
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const brokerUrl = process.env.COMPUTE_BROKER_URL?.trim() || "http://127.0.0.1:4010";
  const token = process.env.COMPUTE_BROKER_INTERNAL_TOKEN?.trim();
  if (!databaseUrl || !token) throw new Error("DATABASE_URL and COMPUTE_BROKER_INTERNAL_TOKEN are required");
  const expectedFingerprint = requiredFlag("--target-fingerprint");
  const actualFingerprint = databaseFingerprint(databaseUrl);
  if (actualFingerprint !== expectedFingerprint) {
    throw new Error(`database fingerprint mismatch: expected ${expectedFingerprint}, got ${actualFingerprint}`);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const sessions = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`
      SELECT "id"
      FROM "ComputeSession"
      WHERE ("delegationTaskId" IS NOT NULL OR "delegationTaskStepId" IS NOT NULL)
        AND "endedAt" IS NULL
      ORDER BY "createdAt", "id"
    `);
    let completed = 0;
    const failures: Array<{ id: string; status: number; error: string }> = [];
    const queue = [...sessions];
    const worker = async () => {
      for (;;) {
        const session = queue.shift();
        if (!session) return;
        try {
          const response = await fetch(
            `${brokerUrl}/internal/compute/sessions/${encodeURIComponent(session.id)}/terminate`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ reason: "pi_legacy_schema_removal" }),
              signal: AbortSignal.timeout(60_000),
            },
          );
          if (!response.ok) {
            failures.push({
              id: session.id,
              status: response.status,
              error: (await response.text()).slice(0, 240),
            });
          } else {
            completed += 1;
            if (completed % 10 === 0 || completed === sessions.length) {
              process.stdout.write(`terminated=${completed}/${sessions.length}\n`);
            }
          }
        } catch (error) {
          failures.push({
            id: session.id,
            status: 0,
            error: error instanceof Error ? error.message : "unknown termination failure",
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, sessions.length || 1) }, worker));
    if (failures.length) {
      process.stderr.write(`${JSON.stringify({ completed, failures }, null, 2)}\n`);
      throw new Error(`failed to terminate ${failures.length} legacy ComputeSession(s)`);
    }
    process.stdout.write(`legacy_sessions_terminated=${completed}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
