import { AsyncLocalStorage } from "node:async_hooks";
export type IngestionCheckpoint = Record<string, string>;
export const knowledgeIngestionContext = new AsyncLocalStorage<{
  checkpoint: IngestionCheckpoint;
  save: (key: string, value: string) => Promise<void>;
}>();
export class KnowledgeProcessingPending extends Error {}
