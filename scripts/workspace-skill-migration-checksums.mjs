#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

function fail(message) {
  process.stderr.write(`workspace-skill migration checksum gate: ${message}\n`);
  process.exit(2);
}

const migrationsRoot = process.argv[2];
if (!migrationsRoot) {
  fail("the local Prisma migrations directory must be provided.");
}

const resolvedRoot = resolve(migrationsRoot);
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

const mismatches = [];
const seen = new Set();

for (const rawLine of input.split(/\r?\n/)) {
  if (!rawLine.trim()) continue;

  const separatorIndex = rawLine.indexOf("|");
  if (separatorIndex < 1 || rawLine.indexOf("|", separatorIndex + 1) !== -1) {
    fail("database output contained an invalid migration row.");
  }

  const migrationName = rawLine.slice(0, separatorIndex).trim();
  const databaseChecksum = rawLine.slice(separatorIndex + 1).trim().toLowerCase();

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(migrationName)) {
    fail("database output contained an unsafe migration name.");
  }
  if (!/^[a-f0-9]{64}$/.test(databaseChecksum)) {
    fail(`database checksum is invalid for ${migrationName}.`);
  }
  if (seen.has(migrationName)) {
    fail(`database output contained duplicate migration ${migrationName}.`);
  }
  seen.add(migrationName);

  const migrationPath = resolve(resolvedRoot, migrationName, "migration.sql");
  if (!migrationPath.startsWith(`${resolvedRoot}${sep}`)) {
    fail("resolved migration path escaped the migrations directory.");
  }

  let source;
  try {
    source = readFileSync(migrationPath);
  } catch {
    mismatches.push([migrationName, "missing_local"]);
    continue;
  }

  const localChecksum = createHash("sha256").update(source).digest("hex");
  if (localChecksum !== databaseChecksum) {
    mismatches.push([migrationName, "checksum_mismatch"]);
  }
}

for (const [migrationName, reason] of mismatches) {
  process.stdout.write(`${migrationName}|${reason}\n`);
}

if (mismatches.length > 0) process.exit(1);
