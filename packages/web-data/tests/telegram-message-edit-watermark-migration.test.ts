import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../prisma/migrations/20260806240000_telegram_edit_inbox_watermark/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const schema = readFileSync(
  new URL("../../../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const service = readFileSync(
  new URL("../../../apps/bot/src/telegram-message-edit-inbox.ts", import.meta.url),
  "utf8",
);

describe("Telegram edited_message migration contract", () => {
  it("makes update_id the only ordering authority and keeps editedAt as audit data", () => {
    expect(migration).toContain('ADD COLUMN "telegramLastEditUpdateId" BIGINT');
    expect(migration).toContain('ADD COLUMN "telegramLastEditAt" TIMESTAMP(3)');
    expect(migration).toContain(
      'NEW."telegramLastEditUpdateId"\n           <= OLD."telegramLastEditUpdateId"',
    );
    expect(migration).not.toMatch(/NEW\."telegramLastEditAt"\s*[<>]=?/);
    expect(migration).not.toMatch(/OLD\."telegramLastEditAt"\s*[<>]=?/);
    expect(migration).toContain(
      "Telegram message edit watermark must increase.",
    );
    expect(schema).toContain("telegramLastEditUpdateId           BigInt?");
    expect(schema).toContain("telegramLastEditAt                 DateTime?");
  });

  it("adds owner-fenced inbox leases used by every terminal transition", () => {
    expect(migration).toContain('ADD COLUMN "leaseToken" TEXT');
    expect(migration).toContain('ADD COLUMN "leaseExpiresAt" TIMESTAMP(3)');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "ChannelEventInbox_leaseToken_key"',
    );
    expect(migration).toContain(
      'ADD CONSTRAINT "ChannelEventInbox_lease_pair_check"',
    );
    expect(migration).toContain(
      '"leaseToken" IS NULL\n      AND "leaseExpiresAt" IS NULL',
    );
    expect(schema).toContain("leaseToken            String?                   @unique");
    expect(schema).toContain("leaseExpiresAt        DateTime?");

    const ownerCasChecks = service.match(
      /inbox\."leaseExpiresAt" > clock_timestamp\(\)/g,
    ) ?? [];
    expect(ownerCasChecks.length).toBeGreaterThanOrEqual(4);
    expect(service).toContain('inbox."leaseToken" = ${input.claim.leaseToken}');
  });

  it("dead-letters only deterministic failures and retries safety controls without a ceiling", () => {
    const retrySection = service.slice(
      service.indexOf("export async function retryPendingTelegramMessageEdits"),
      service.indexOf("export async function replayTelegramMessageEditInbox"),
    );
    expect(retrySection).not.toContain('status: "DEAD_LETTER"');
    expect(service).not.toContain("telegramMessageEditMaximumAttempts");
    expect(service).toContain("if (!disposition.retryable)");
    expect(service).not.toContain('inbox."attemptCount" <');
    expect(service).toContain("export async function replayTelegramMessageEditInbox");
  });
});
