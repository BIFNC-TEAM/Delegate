import {
  runOpenVikingMemoryDeletionRecoveryTick,
  runRepresentativeOpenVikingSyncJobsTick,
  type OpenVikingMemoryDeletionTickSummary,
  type OpenVikingSyncTickSummary,
} from "@delegate/web-data";

export type OpenVikingOperationsTickResult = {
  sync: OpenVikingSyncTickSummary | null;
  memoryDeletion: OpenVikingMemoryDeletionTickSummary | null;
  failedLaneCodes: string[];
};

type OpenVikingOperationsDependencies = {
  runSyncJobsTick: typeof runRepresentativeOpenVikingSyncJobsTick;
  runMemoryDeletionTick: typeof runOpenVikingMemoryDeletionRecoveryTick;
};

const defaultDependencies: OpenVikingOperationsDependencies = {
  runSyncJobsTick: runRepresentativeOpenVikingSyncJobsTick,
  runMemoryDeletionTick: runOpenVikingMemoryDeletionRecoveryTick,
};

export async function runOpenVikingOperationsTick(
  config: {
    syncBatchSize: number;
    memoryDeletionBatchSize: number;
  },
  dependencies: OpenVikingOperationsDependencies = defaultDependencies,
): Promise<OpenVikingOperationsTickResult> {
  const [sync, memoryDeletion] = await Promise.allSettled([
    dependencies.runSyncJobsTick({
      limit: config.syncBatchSize,
    }),
    dependencies.runMemoryDeletionTick({
      limit: config.memoryDeletionBatchSize,
    }),
  ]);

  return {
    sync: sync.status === "fulfilled" ? sync.value : null,
    memoryDeletion:
      memoryDeletion.status === "fulfilled"
        ? memoryDeletion.value
        : null,
    failedLaneCodes: [
      ...(sync.status === "rejected"
        ? ["openviking_sync_tick_failed"]
        : []),
      ...(memoryDeletion.status === "rejected"
        ? ["openviking_memory_deletion_tick_failed"]
        : []),
    ],
  };
}
