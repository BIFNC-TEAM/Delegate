/** Local only: prints private test content on explicit request, never exposes an HTTP route. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const [directory, runId, mode] = process.argv.slice(2);
if (!directory) throw Error("Usage: node --import tsx scripts/read-local-trace.ts <directory> [runId] [--full]");
const files = readdirSync(directory).filter(name => name.endsWith(".jsonl"));
for (const file of files.sort()) {
  const lines = readFileSync(join(directory, file), "utf8").trim().split("\n");
  const rows = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return [{ event: "INCOMPLETE_JSON_RECORD", at: "", data: {} }]; } });
  if (runId && !rows.some(row => JSON.stringify(row).includes(runId))) continue;
  console.log(`\n${file}`);
  for (const row of rows) console.log(mode === "--full" ? JSON.stringify(row, null, 2) : `${row.at} #${row.sequence} +${Math.round(row.elapsedMs ?? 0)}ms ${row.event}${row.data?.error ? ` ERROR ${row.data.error.code ?? row.data.error.message ?? "unknown"}` : ""}`);
  if (!rows.some(row => ["lifecycle.completed", "lifecycle.failed"].includes(row.event))) console.log("INCOMPLETE: no terminal event (process may have stopped)");
}
