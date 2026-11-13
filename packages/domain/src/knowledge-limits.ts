/** Shared knowledge ingestion limits; byte limits use MiB. */
export const KNOWLEDGE_FILE_BYTES = 150 * 1024 * 1024;
export const KNOWLEDGE_REQUEST_BYTES = 160 * 1024 * 1024;
export const KNOWLEDGE_TEXT_CHARACTERS = 2_000_000;
export const KNOWLEDGE_RESULT_BYTES = 16 * 1024 * 1024;
export const KNOWLEDGE_BATCH_BYTES = 150 * 1024 * 1024;
export function knowledgeTextLimitMessage(length: number): string {
  return `正文共 ${length.toLocaleString("en-US")} 字符，超过 2,000,000 字符上限。请拆分后重新导入。`;
}

/** Persisted failures currently carry human-readable text, including older imports.
 * Only source-size failures are terminal here; network/provider failures remain retryable.
 */
export function requiresKnowledgeSourceChange(message?: string | null): boolean {
  return Boolean(message && (
    /正文[^\n]*(?:超过|超出)[^\n]*字符/.test(message)
    || /文件不能超过\s*\d+\s*MB/i.test(message)
  ));
}
