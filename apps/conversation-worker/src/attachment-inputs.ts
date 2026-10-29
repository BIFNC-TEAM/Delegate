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
  if(!input.attachments.length) return { ok: true };
  const selectedIds = resolveDeclaredAttachmentIds(input);
  if(!input.attachmentIds.length && !selectedIds.length) {
    return { ok: false, reason: "sandbox_attachment_selection_missing" };
  }
  const selected = input.attachments.filter((attachment) =>
    selectedIds.includes(attachment.id));
  if(!selected.length) return { ok: false, reason: "sandbox_attachment_selection_unknown" };
  if(selected.some((attachment) => !declaresFileRead(
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
    if(!requested.size) return declaresFileRead(input.code, path);
    return requested.has(attachment.id)
      || requested.has(attachment.fileName)
      || requested.has(path);
  }).map((attachment) => attachment.id);
}

function declaresFileRead(code: string, path: string) {
  const escapedPath = escapeRegExp(path);
  if(new RegExp(`(?:open|readFileSync|createReadStream)\\(\\s*["']${escapedPath}["']`, "u").test(code)) {
    return true;
  }
  const assignment = code.match(new RegExp(
    `\\b([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*["']${escapedPath}["']`,
    "u",
  ));
  if(assignment?.[1] && new RegExp(
    `(?:open|readFileSync|createReadStream)\\(\\s*${escapeRegExp(assignment[1])}\\b`,
    "u",
  ).test(code)) return true;
  const structuredReader = "(?:[A-Za-z_][A-Za-z0-9_]*\\.)*(?:read_csv|read_csv_auto|scan_csv|loadtxt|genfromtxt)";
  const optionalPathKeyword = "(?:(?:filepath_or_buffer|source|path)\\s*=\\s*)?";
  if(new RegExp(
    `${structuredReader}\\(\\s*${optionalPathKeyword}["']${escapedPath}["']`,
    "u",
  ).test(code)) return true;
  if(assignment?.[1] && new RegExp(
    `${structuredReader}\\(\\s*${optionalPathKeyword}${escapeRegExp(assignment[1])}\\b`,
    "u",
  ).test(code)) return true;
  return new RegExp(`\\b(?:cat|awk|sed)\\b[^\\n]*${escapedPath}`, "u").test(code);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
