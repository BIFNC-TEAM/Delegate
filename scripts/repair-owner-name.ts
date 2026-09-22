import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { applyOwnerNameRepair, previewOwnerNameRepair } from "../packages/web-data/src/owner-name-repair";
import { prisma } from "../packages/web-data/src/prisma";

export function ownerNameRepairDatabaseTarget(databaseUrl: string | undefined): string {
  if (!databaseUrl?.trim()) throw new Error("DATABASE_URL is required.");
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must identify a PostgreSQL database.");
  }
  // Bind the preview to a database/schema without persisting its credentials.
  const target = [url.hostname, url.port || "5432", url.pathname, url.searchParams.get("schema") || "public"];
  return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}

export function parseOwnerNameRepairArgs(args: string[]) {
  const [mode, input, output] = args;
  if (
    !input
    || (mode !== "preview" && mode !== "apply")
    || (mode === "preview" ? args.length !== 3 || !output : args.length !== 2)
  ) {
    throw new Error("Usage: repair-owner-name.ts preview <target.json> <plan.json> | apply <plan.json>");
  }
  return { mode, input, output };
}

async function main() {
  const args = parseOwnerNameRepairArgs(process.argv.slice(2));
  const databaseTarget = ownerNameRepairDatabaseTarget(process.env.DATABASE_URL);
  const input: unknown = JSON.parse(await readFile(args.input, "utf8"));
  if (args.mode === "preview") {
    const plan = await previewOwnerNameRepair(input, databaseTarget);
    await writeFile(args.output!, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write("Read-only repair preview saved. Existing account nickname will be preserved.\n");
  } else {
    const result = await applyOwnerNameRepair(input, databaseTarget);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Report failure without printing database credentials, names or raw SQL.
    const message = error instanceof Error && error.message.startsWith("owner_name_repair_")
      ? error.message : "Owner name repair failed; check arguments, plan and database connectivity.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }).finally(() => prisma.$disconnect());
}
