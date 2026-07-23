import type { WorkspaceAuditEvent } from "@delegate/web-data";

export const workspaceAuditCsvHeader = [
  "time",
  "category",
  "event_type",
  "actor",
  "representative",
  "resource_kind",
  "resource_id",
  "trace_id",
  "anomaly",
  "summary",
  "allowlisted_metadata",
] as const;

export function serializeWorkspaceAuditCsvRow(event: WorkspaceAuditEvent) {
  return [
    event.createdAt,
    event.category,
    event.type,
    event.actor ?? "",
    event.representativeName,
    event.resource?.kind ?? "",
    event.resource?.id ?? "",
    event.traceId ?? "",
    event.anomaly,
    event.summary,
    JSON.stringify(event.metadata),
  ].map(escapeAuditCsvCell).join(",");
}

export function createWorkspaceAuditCsvStream(
  events: AsyncIterable<WorkspaceAuditEvent>,
  signal?: AbortSignal,
) {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  let headerPending = true;
  let closed = false;

  async function closeIterator() {
    if (closed) return;
    closed = true;
    await iterator.return?.();
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) {
        controller.close();
        return;
      }
      if (signal?.aborted) {
        await closeIterator();
        controller.close();
        return;
      }
      if (headerPending) {
        headerPending = false;
        controller.enqueue(encoder.encode(
          `\uFEFF${workspaceAuditCsvHeader.map(escapeAuditCsvCell).join(",")}\r\n`,
        ));
        return;
      }
      try {
        const result = await iterator.next();
        if (result.done) {
          await closeIterator();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(
          `${serializeWorkspaceAuditCsvRow(result.value)}\r\n`,
        ));
      } catch {
        await closeIterator().catch(() => undefined);
        controller.error(new Error("Workspace audit export failed."));
      }
    },
    async cancel() {
      await closeIterator();
    },
  }, { highWaterMark: 0 });
}

export function escapeAuditCsvCell(value: string | number | boolean | null) {
  const normalized = value === null ? "" : String(value);
  const spreadsheetSafe = /^(?:\s|[=+\-@])/.test(normalized) ? `'${normalized}` : normalized;
  return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
}
