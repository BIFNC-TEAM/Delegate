import { auditErrorCode } from "@delegate/runtime";

import {
  GENERATION_WORK_LEASE_DURATION_MS,
  GenerationWorkLeaseLostError,
  claimNextGenerationWorkItem,
  renewGenerationWorkItemLease
} from "@delegate/web-data";

export type GenerationItem = NonNullable<Awaited<ReturnType<typeof claimNextGenerationWorkItem>>>;
export type GenerationLease = ReturnType<typeof startGenerationLeaseHeartbeat>;
export type WorkLease = { outboxId: string; leaseAttempt: number };

export function startGenerationLeaseHeartbeat(item: GenerationItem) {
  const controller = new AbortController();
  if(!Number.isSafeInteger(item.leaseAttempt)) {
    return {
      signal: controller.signal,
      assertOwned: () => { },
      confirmOwned: async () => { },
      isLost: () => false,
      stop: () => { },
    };
  }
  let renewing = false;
  let lostError: GenerationWorkLeaseLostError | undefined;
  let stopped = false;
  let heartbeat: ReturnType<typeof setInterval>;
  const markLost = () => {
    if(lostError) return;
    lostError = new GenerationWorkLeaseLostError(item.outboxId, item.leaseAttempt);
    controller.abort(lostError);
    if(heartbeat) clearInterval(heartbeat);
  };
  heartbeat = setInterval(() => {
    if(renewing || stopped || lostError) return;
    renewing = true;
    void renewGenerationWorkItemLease({
      outboxId: item.outboxId,
      leaseAttempt: item.leaseAttempt,
    }).then((renewed) => {
      if(!renewed) markLost();
    }).catch((error) => {
      markLost();
      console.error(`Pi generation lease renewal failed for ${item.runId}.`, auditErrorCode(error));
    }).finally(() => { renewing = false; });
  }, Math.max(1_000, Math.floor(GENERATION_WORK_LEASE_DURATION_MS / 3)));
  heartbeat.unref?.();
  return {
    signal: controller.signal,
    assertOwned() {
      if(lostError) throw lostError;
    },
    async confirmOwned() {
      if(lostError) throw lostError;
      let renewed: boolean;
      try {
        renewed = await renewGenerationWorkItemLease({
          outboxId: item.outboxId,
          leaseAttempt: item.leaseAttempt,
        });
      } catch(error) {
        markLost();
        throw error;
      }
      if(!renewed) {
        markLost();
        throw lostError;
      }
    },
    isLost: () => Boolean(lostError),
    stop() {
      stopped = true;
      clearInterval(heartbeat);
    },
  };
}
