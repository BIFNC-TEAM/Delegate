import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(fileURLToPath(new URL(
  "../../../prisma/migrations/20260911150000_memory_use_handoff_terminalization/migration.sql",
  import.meta.url,
)), "utf8");

describe("MemoryUseRun handoff terminalization migration", () => {
  it("keeps active-episode enforcement for open runs but permits terminal closure", () => {
    expect(migration).toContain('OLD."status" = \'STARTED\'::"MemoryUseRunStatus"');
    expect(migration).toContain('NEW."status" = \'STARTED\'::"MemoryUseRunStatus"');
    expect(migration).toContain("pg_get_functiondef('memory_use_run_channel_guard()'::regprocedure)");
  });
});
