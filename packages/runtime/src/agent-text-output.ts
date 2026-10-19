import { agentTextFileOutput } from "@delegate/domain";

type TextFormat = keyof typeof agentTextFileOutput.formats;
type OutputFile = { fileName: string; format: TextFormat; mimeType: string };
type OutputRequest = { ok: true; file?: OutputFile } | { ok: false; reason: string };

export function validateAgentTextOutputRequest(paths: readonly string[]): OutputRequest {
  if (paths.length > agentTextFileOutput.maximumFiles) return { ok: false, reason: "output_file_count_exceeded" };
  if (!paths.length) return { ok: true };
  const fileName = paths[0]!.replace(/^(?:\/workspace\/)?outputs\//u, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(fileName)) return { ok: false, reason: "output_file_name_invalid" };
  const format = fileName.split(".").at(-1)?.toLowerCase();
  if (!format || !Object.hasOwn(agentTextFileOutput.formats, format)) return { ok: false, reason: "output_format_unsupported" };
  return { ok: true, file: { fileName, format: format as TextFormat, mimeType: agentTextFileOutput.formats[format as TextFormat] } };
}

export function validateAgentTextOutputContent(file: OutputFile, text: string): { ok: true } | { ok: false; reason: string } {
  if (new TextEncoder().encode(text).byteLength > agentTextFileOutput.maximumBytes) return { ok: false, reason: "output_file_too_large" };
  if (!text.length || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return { ok: false, reason: "output_not_supported_text" };
  if (file.format === "json") {
    try { JSON.parse(text); } catch { return { ok: false, reason: "output_json_invalid" }; }
  }
  if (file.format === "csv" && !isRectangularCsvWithHeader(text)) return { ok: false, reason: "output_csv_invalid" };
  return { ok: true };
}

// Validate complete quoted fields and row widths, including multiline values.
// This checks the format only; correctness of the analysis needs task evidence.
function isRectangularCsvWithHeader(text: string): boolean {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  const fieldEnd = () => { row.push(field); field = ""; closed = false; };
  const rowEnd = () => { fieldEnd(); rows.push(row); row = []; };
  const content = text.replace(/^\uFEFF/u, "");
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (quoted) {
      if (char === '"') {
        if (content[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === ",") fieldEnd();
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && content[index + 1] === "\n") index += 1;
      rowEnd();
    } else if (char === '"' && !field.length && !closed) quoted = true;
    else if (char === '"' || closed) return false;
    else field += char;
  }
  if (quoted) return false;
  if (row.length || field.length || closed) rowEnd();
  const header = rows[0];
  return Boolean(header?.length
    && header.every(name => name.trim().length > 0 && !/[\r\n]/u.test(name))
    && new Set(header).size === header.length
    && rows.every(values => values.length === header.length));
}
