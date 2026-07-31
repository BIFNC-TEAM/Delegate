#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  openSync,
  readFileSync,
  writeFileSync,
  closeSync,
} from "node:fs";

function fail(message) {
  process.stderr.write(`Logto Account approval validation: ${message}\n`);
  process.exit(1);
}

function parseCsv(source) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) {
    fail("the preflight report contains an unterminated CSV field.");
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/u, ""));
    rows.push(row);
  }
  return rows.filter((candidate) =>
    candidate.some((value) => value.length > 0),
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function detailsHash(details) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(details)), "utf8")
    .digest("hex");
}

function readReviewRows(reportPath) {
  const rows = parseCsv(readFileSync(reportPath, "utf8"));
  const header = rows.shift();
  const requiredColumns = [
    "severity",
    "issue_code",
    "entity_type",
    "entity_key",
    "details",
  ];
  if (!header) {
    fail("the preflight report is empty.");
  }
  const columns = Object.fromEntries(
    requiredColumns.map((name) => [name, header.indexOf(name)]),
  );
  if (Object.values(columns).some((index) => index < 0)) {
    fail("the preflight report header is incompatible.");
  }

  return rows
    .filter((row) => row[columns.severity] === "REVIEW")
    .map((row) => {
      let details;
      try {
        details = JSON.parse(row[columns.details]);
      } catch {
        fail("a REVIEW row contains invalid JSON details.");
      }
      return {
        issueCode: row[columns.issue_code],
        entityType: row[columns.entity_type],
        entityKey: row[columns.entity_key],
        detailsSha256: detailsHash(details),
      };
    });
}

function approvalKey(value) {
  return [value.issueCode, value.entityType, value.entityKey].join("\u0000");
}

function writeTemplate(reportPath, outputPath) {
  const reviews = readReviewRows(reportPath);
  const artifact = {
    version: 1,
    generatedAt: new Date().toISOString(),
    approvals: reviews.map((review) => ({
      ...review,
      decision: "",
      approvedBy: "",
      approvedAt: "",
    })),
  };
  let descriptor;
  try {
    descriptor = openSync(outputPath, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    fail(
      error?.code === "EEXIST"
        ? `refusing to overwrite approval artifact: ${outputPath}`
        : `could not write approval artifact: ${outputPath}`,
    );
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  process.stdout.write(
    `Wrote ${reviews.length} REVIEW approval template row(s) to ${outputPath}.\n`,
  );
}

function verifyApprovals(reportPath, approvalsPath) {
  const reviews = readReviewRows(reportPath);
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(approvalsPath, "utf8"));
  } catch {
    fail(`could not parse approval artifact: ${approvalsPath}`);
  }
  if (
    !artifact
    || artifact.version !== 1
    || !Array.isArray(artifact.approvals)
  ) {
    fail("the approval artifact must use version 1 and contain approvals[].");
  }

  const expected = new Map();
  for (const review of reviews) {
    const key = approvalKey(review);
    if (expected.has(key)) {
      fail("the preflight report contains a duplicate REVIEW identity.");
    }
    expected.set(key, review);
  }

  const seen = new Set();
  for (const approval of artifact.approvals) {
    if (!approval || typeof approval !== "object") {
      fail("every approval must be an object.");
    }
    const key = approvalKey(approval);
    const review = expected.get(key);
    if (!review) {
      fail("the artifact contains a stale or unknown approval row.");
    }
    if (seen.has(key)) {
      fail("the artifact contains a duplicate approval row.");
    }
    seen.add(key);
    if (approval.detailsSha256 !== review.detailsSha256) {
      fail("a REVIEW row changed after its approval template was generated.");
    }
    if (
      typeof approval.decision !== "string"
      || !approval.decision.trim()
      || typeof approval.approvedBy !== "string"
      || !approval.approvedBy.trim()
      || typeof approval.approvedAt !== "string"
      || !approval.approvedAt.trim()
      || !Number.isFinite(Date.parse(approval.approvedAt))
    ) {
      fail("every approval requires decision, approvedBy, and approvedAt.");
    }
  }

  if (seen.size !== expected.size) {
    fail("the approval artifact does not cover every current REVIEW row.");
  }
  process.stdout.write(`Validated ${seen.size} approved REVIEW row(s).\n`);
}

const [mode, reportPath, artifactPath] = process.argv.slice(2);
if (
  !["template", "verify"].includes(mode)
  || !reportPath
  || !artifactPath
) {
  fail(
    "usage: logto-account-identity-approvals.mjs <template|verify> <report.csv> <artifact.json>",
  );
}

if (mode === "template") {
  writeTemplate(reportPath, artifactPath);
} else {
  verifyApprovals(reportPath, artifactPath);
}
