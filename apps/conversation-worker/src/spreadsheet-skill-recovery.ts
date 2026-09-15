import { createHash } from "node:crypto";

export const BUILTIN_SPREADSHEET_SKILL = {
  id: "spreadsheet-analysis",
  version: "1.0.0",
  resource: "skill://builtin/spreadsheet-analysis/1.0.0",
  instructionsDigest: "466c5f1f629df8d0decc05d74ea966aca7c693c00c0fb664661578322272f7b9",
} as const;

export function isStructuredDataAttachment(input: {
  fileName: string;
  mimeType: string;
}) {
  return /(?:csv|spreadsheet|excel|json)/iu.test(input.mimeType)
    || /\.(?:csv|xlsx?|json)$/iu.test(input.fileName);
}

type RecoverySkill = {
  slug: string;
  version?: string | undefined;
  enabled: boolean;
  instructions?: string | undefined;
  instructionsSha256?: string | undefined;
  resources?: string[] | undefined;
};

type RecoveryAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  uri?: string | undefined;
};

export function validateDeclaredAttachmentRead(input: {
  code: string;
  attachmentIds: readonly string[];
  attachments: readonly RecoveryAttachment[];
}): { ok: true } | { ok: false; reason: string } {
  if (!input.attachments.length) return { ok: true };
  const selectedIds = resolveDeclaredAttachmentIds(input);
  if (!input.attachmentIds.length && !selectedIds.length) {
    return { ok: false, reason: "sandbox_attachment_selection_missing" };
  }
  const selected = input.attachments.filter((attachment) =>
    selectedIds.includes(attachment.id));
  if (!selected.length) return { ok: false, reason: "sandbox_attachment_selection_unknown" };
  if (selected.some((attachment) => !declaresFileRead(
    input.code,
    attachment.uri ?? `/workspace/inputs/${attachment.fileName}`,
  ))) {
    return { ok: false, reason: "sandbox_attachment_path_not_read" };
  }
  return { ok: true };
}

export function resolveDeclaredAttachmentIds(input: {
  code: string;
  attachmentIds: readonly string[];
  attachments: readonly RecoveryAttachment[];
}) {
  const requested = new Set(
    input.attachmentIds.map((value) => value.trim()).filter(Boolean),
  );
  return input.attachments.filter((attachment) => {
    const path = attachment.uri ?? `/workspace/inputs/${attachment.fileName}`;
    if (!requested.size) return declaresFileRead(input.code, path);
    return requested.has(attachment.id)
      || requested.has(attachment.fileName)
      || requested.has(path);
  }).map((attachment) => attachment.id);
}

function declaresFileRead(code: string, path: string) {
  const escapedPath = escapeRegExp(path);
  if (new RegExp(`(?:open|readFileSync|createReadStream)\\(\\s*["']${escapedPath}["']`, "u").test(code)) {
    return true;
  }
  const assignment = code.match(new RegExp(
    `\\b([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*["']${escapedPath}["']`,
    "u",
  ));
  if (assignment?.[1] && new RegExp(
    `(?:open|readFileSync|createReadStream)\\(\\s*${escapeRegExp(assignment[1])}\\b`,
    "u",
  ).test(code)) return true;
  const structuredReader = "(?:[A-Za-z_][A-Za-z0-9_]*\\.)*(?:read_csv|read_csv_auto|scan_csv|loadtxt|genfromtxt)";
  const optionalPathKeyword = "(?:(?:filepath_or_buffer|source|path)\\s*=\\s*)?";
  if (new RegExp(
    `${structuredReader}\\(\\s*${optionalPathKeyword}["']${escapedPath}["']`,
    "u",
  ).test(code)) return true;
  if (assignment?.[1] && new RegExp(
    `${structuredReader}\\(\\s*${optionalPathKeyword}${escapeRegExp(assignment[1])}\\b`,
    "u",
  ).test(code)) return true;
  return new RegExp(`\\b(?:cat|awk|sed)\\b[^\\n]*${escapedPath}`, "u").test(code);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export type SpreadsheetSkillRecoveryPlan = {
  skill: typeof BUILTIN_SPREADSHEET_SKILL;
  request: {
    language: "python";
    code: string;
    attachmentIds: string[];
    expectedOutputs: string[];
    timeoutMs: number;
  };
};

export function compileBuiltinSpreadsheetRecovery(input: {
  userText: string;
  skills: readonly RecoverySkill[];
  attachments: readonly RecoveryAttachment[];
}): SpreadsheetSkillRecoveryPlan | undefined {
  const skill = input.skills.find((candidate) =>
    candidate.enabled
    && candidate.slug === BUILTIN_SPREADSHEET_SKILL.id
    && candidate.version === BUILTIN_SPREADSHEET_SKILL.version);
  if (!skill?.instructions || !skill.instructionsSha256) return undefined;
  const calculatedDigest = createHash("sha256").update(skill.instructions).digest("hex");
  if (
    calculatedDigest !== skill.instructionsSha256.toLocaleLowerCase()
    || calculatedDigest !== BUILTIN_SPREADSHEET_SKILL.instructionsDigest
    || skill.resources?.length !== 1
    || skill.resources[0] !== BUILTIN_SPREADSHEET_SKILL.resource
  ) return undefined;

  if (input.attachments.length !== 1) return undefined;
  const attachment = input.attachments[0]!;
  if (!/\.csv$/iu.test(attachment.fileName) || !/(?:csv|text\/plain)/iu.test(attachment.mimeType)) {
    return undefined;
  }
  const expectedInputPath = attachment.uri;
  if (
    !expectedInputPath
    || !expectedInputPath.startsWith("/workspace/inputs/")
    || !expectedInputPath.toLocaleLowerCase().endsWith(".csv")
  ) return undefined;

  const outputFileName = resolveRequestedOutputFileName(
    input.userText,
    input.attachments.map((candidate) => candidate.fileName),
  );
  if (!outputFileName?.toLocaleLowerCase().endsWith(".csv")) return undefined;

  const normalized = input.userText.normalize("NFKC");
  const compact = normalized.replace(/\s+/gu, "").toLocaleLowerCase();
  const requestsNetSalesFormula = compact.includes("quantity*unit_price-refund_amount")
    || compact.includes("quantity×unit_price-refund_amount");
  if (!requestsNetSalesFormula) return undefined;

  const city = parseExplicitCityFilter(normalized);
  let code: string;
  if (city) {
    if (!compact.includes("order_id,city,net_sales_cny")) return undefined;
    code = buildCityFilterProgram(expectedInputPath, city);
  } else {
    if (!compact.includes("metric,value")) return undefined;
    code = buildSummaryProgram(expectedInputPath);
  }

  return {
    skill: BUILTIN_SPREADSHEET_SKILL,
    request: {
      language: "python",
      code,
      attachmentIds: [attachment.id],
      expectedOutputs: [outputFileName],
      timeoutMs: 120_000,
    },
  };
}

export function resolveRequestedOutputFileName(value: string, inputFileNames: string[] = []) {
  const matches = value.match(/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:csv|json|txt|md)\b/giu) ?? [];
  const inputs = new Set(inputFileNames.map((name) => name.toLocaleLowerCase()));
  const unique = [...new Set(matches.map((match) => match.split(/[\\/]/u).pop()!).filter((name) =>
    Boolean(name) && !inputs.has(name.toLocaleLowerCase())))];
  return unique.length === 1 ? unique[0] : undefined;
}

function parseExplicitCityFilter(value: string) {
  const explicit = value.match(/\bcity\s*=\s*([^\s,，。;；]+)/iu)?.[1]?.trim();
  if (!explicit || explicit.length > 40 || /["'`\\/]/u.test(explicit)) return undefined;
  return explicit;
}

function buildSummaryProgram(inputPath: string) {
  return [
    "import csv",
    "import sys",
    "from decimal import Decimal, InvalidOperation",
    "",
    `INPUT_PATH = ${JSON.stringify(inputPath)}`,
    "REQUIRED = {'status', 'quantity', 'unit_price', 'refund_amount'}",
    "rows = 0",
    "net_sales = Decimal('0')",
    "with open(INPUT_PATH, encoding='utf-8-sig', newline='') as source:",
    "    reader = csv.DictReader(source)",
    "    fields = set(reader.fieldnames or [])",
    "    if not REQUIRED.issubset(fields):",
    "        raise ValueError('CSV is missing required spreadsheet-analysis fields')",
    "    for row in reader:",
    "        if row['status'].strip().lower() != 'completed':",
    "            continue",
    "        try:",
    "            net_sales += Decimal(row['quantity']) * Decimal(row['unit_price']) - Decimal(row['refund_amount'])",
    "        except (InvalidOperation, TypeError) as error:",
    "            raise ValueError('CSV contains an invalid numeric value') from error",
    "        rows += 1",
    "",
    "def decimal_text(value):",
    "    rendered = format(value, 'f')",
    "    return rendered.rstrip('0').rstrip('.') if '.' in rendered else rendered",
    "",
    "writer = csv.writer(sys.stdout, lineterminator='\\n')",
    "writer.writerow(['metric', 'value'])",
    "writer.writerow(['rows', rows])",
    "writer.writerow(['net_sales_cny', decimal_text(net_sales)])",
  ].join("\n");
}

function buildCityFilterProgram(inputPath: string, city: string) {
  return [
    "import csv",
    "import sys",
    "from decimal import Decimal, InvalidOperation",
    "",
    `INPUT_PATH = ${JSON.stringify(inputPath)}`,
    `TARGET_CITY = ${JSON.stringify(city)}`,
    "REQUIRED = {'order_id', 'city', 'status', 'quantity', 'unit_price', 'refund_amount'}",
    "writer = csv.writer(sys.stdout, lineterminator='\\n')",
    "writer.writerow(['order_id', 'city', 'net_sales_cny'])",
    "with open(INPUT_PATH, encoding='utf-8-sig', newline='') as source:",
    "    reader = csv.DictReader(source)",
    "    fields = set(reader.fieldnames or [])",
    "    if not REQUIRED.issubset(fields):",
    "        raise ValueError('CSV is missing required spreadsheet-analysis fields')",
    "    for row in reader:",
    "        if row['status'].strip().lower() != 'completed' or row['city'].strip() != TARGET_CITY:",
    "            continue",
    "        try:",
    "            amount = Decimal(row['quantity']) * Decimal(row['unit_price']) - Decimal(row['refund_amount'])",
    "        except (InvalidOperation, TypeError) as error:",
    "            raise ValueError('CSV contains an invalid numeric value') from error",
    "        rendered = format(amount, 'f')",
    "        writer.writerow([row['order_id'], row['city'], rendered.rstrip('0').rstrip('.') if '.' in rendered else rendered])",
  ].join("\n");
}
