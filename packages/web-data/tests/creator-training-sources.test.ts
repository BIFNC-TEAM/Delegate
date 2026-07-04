import { describe, expect, it } from "vitest";

import {
  createCreatorTrainingSource,
  disableCreatorTrainingSource,
  listCreatorTrainingSources,
  updateCreatorTrainingSource,
} from "../src/creator-training";

describe("creator training sources", () => {
  it("creates and lists representative-scoped sources", async () => {
    const client = new FakeCreatorTrainingClient();

    const source = await createCreatorTrainingSource(
      "lin",
      {
        kind: "url",
        title: "Refund policy",
        locator: "https://example.com/refunds",
        createdBy: "owner-1",
      },
      client,
    );

    expect(source).toMatchObject({
      representativeId: "rep-1",
      kind: "url",
      status: "draft",
      title: "Refund policy",
      locator: "https://example.com/refunds",
    });
    await createCreatorTrainingSource(
      "ada",
      {
        kind: "text",
        title: "Ada source",
        contentText: "Do not leak into Lin.",
      },
      client,
    );

    const sources = await listCreatorTrainingSources("lin", client);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.representativeId).toBe("rep-1");
  });

  it("updates and disables only sources owned by the representative", async () => {
    const client = new FakeCreatorTrainingClient();
    const linSource = await createCreatorTrainingSource(
      "lin",
      {
        kind: "text",
        title: "Old title",
        contentText: "First version",
      },
      client,
    );

    const updated = await updateCreatorTrainingSource(
      "lin",
      linSource.id,
      {
        title: "New title",
        status: "active",
        contentText: "Better source text",
      },
      client,
    );
    const disabled = await disableCreatorTrainingSource("lin", linSource.id, client);

    expect(updated.title).toBe("New title");
    expect(updated.status).toBe("active");
    expect(disabled.status).toBe("disabled");
    await expect(disableCreatorTrainingSource("ada", linSource.id, client)).rejects.toThrow(
      "Creator training source not found.",
    );
  });

  it("rejects empty source titles and unsupported kind values", async () => {
    const client = new FakeCreatorTrainingClient();

    await expect(
      createCreatorTrainingSource(
        "lin",
        {
          kind: "text",
          title: "",
        },
        client,
      ),
    ).rejects.toThrow("title is required");
    await expect(
      createCreatorTrainingSource(
        "lin",
        {
          kind: "unknown",
          title: "Bad kind",
        },
        client,
      ),
    ).rejects.toThrow("Unsupported creator training source kind");
  });
});

type RepresentativeRow = {
  id: string;
  slug: string;
};

type SourceRow = {
  id: string;
  representativeId: string;
  kind: string;
  status: string;
  title: string;
  locator: string | null;
  contentText: string | null;
  metadata: unknown;
  lastSyncedAt: Date | null;
  errorReason: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

class FakeCreatorTrainingClient {
  representatives: RepresentativeRow[] = [
    { id: "rep-1", slug: "lin" },
    { id: "rep-2", slug: "ada" },
  ];
  sources: SourceRow[] = [];

  representative = {
    findUnique: async (args: any) =>
      this.representatives.find((rep) => rep.slug === args.where.slug) ?? null,
  };

  creatorTrainingSource = {
    create: async (args: any) => {
      const now = new Date(`2026-07-04T12:00:${String(this.sources.length).padStart(2, "0")}.000Z`);
      const source: SourceRow = {
        id: `source-${this.sources.length + 1}`,
        representativeId: args.data.representativeId,
        kind: args.data.kind,
        status: args.data.status ?? "DRAFT",
        title: args.data.title,
        locator: args.data.locator ?? null,
        contentText: args.data.contentText ?? null,
        metadata: args.data.metadata ?? null,
        lastSyncedAt: null,
        errorReason: null,
        createdBy: args.data.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.sources.push(source);
      return source;
    },
    findMany: async (args: any) =>
      this.sources
        .filter((source) => source.representativeId === args.where.representativeId)
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()),
    findFirst: async (args: any) =>
      this.sources.find(
        (source) =>
          source.id === args.where.id && source.representativeId === args.where.representativeId,
      ) ?? null,
    update: async (args: any) => {
      const source = this.sources.find((item) => item.id === args.where.id);
      if (!source) {
        throw new Error("source not found");
      }
      Object.assign(source, args.data, { updatedAt: new Date("2026-07-04T12:10:00.000Z") });
      return source;
    },
  };
}
