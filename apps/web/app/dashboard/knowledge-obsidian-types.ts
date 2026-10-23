import type { ObsidianImportMetadata } from "@delegate/web-data/knowledge-obsidian";

export type ObsidianReadResult = {
  files: { path: string; file: File; publishSource?: NonNullable<ObsidianImportMetadata["publishSource"]> }[];
  availablePaths: string[];
};
