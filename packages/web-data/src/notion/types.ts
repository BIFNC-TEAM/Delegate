import { z } from "zod";

export const notionImportSchema = z.object({
  pageId: z.uuid(),
  workspaceId: z.string().min(1).max(128),
  workspaceName: z.string().max(512),
  sourceUrl: z.url().max(2048).refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      /(^|\.)notion\.(so|site|com)$/.test(url.hostname);
  }),
  importedAt: z.iso.datetime(),
  warnings: z.array(z.string().max(2048)).max(100),
  incomplete: z.boolean(),
}).strict();
export type NotionImportMetadata = z.infer<typeof notionImportSchema>;
export type NotionEntry = { id: string; title: string; url: string; kind: "page" | "data_source"; parentId: string | null };
export type NotionDocument = { id: string; title: string; text: string; metadata: NotionImportMetadata };
export type NotionConnectionInfo = { id: string; workspaceId: string; workspaceName: string; expiresAt: string };
export class NotionError extends Error {
  constructor(public code: "CONFIG" | "AUTH" | "ACCESS" | "LIMIT" | "NETWORK" | "STATE", message: string) { super(message); }
}
