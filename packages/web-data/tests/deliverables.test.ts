import { describe, expect, it } from "vitest";

import {
  buildDeliverablePackagingPreset,
  buildRepresentativeDeliverableInsights,
  computeDeliverablePackageCacheKey,
  type DeliverableInsightsSource,
} from "../src/deliverable-insights";
import { getRepresentativePublicDeliverables } from "../src/deliverables";

function createSource(): DeliverableInsightsSource {
  return {
    representative: {
      slug: "lin-founder-rep",
      displayName: "Lin Founder Rep",
    },
    artifacts: [
      {
        id: "artifact_shot_a",
        kind: "screenshot",
        isPinned: true,
        sizeBytes: 140000,
        createdAt: "2026-03-25T10:00:00.000Z",
      },
      {
        id: "artifact_json_a",
        kind: "json",
        isPinned: true,
        sizeBytes: 12000,
        createdAt: "2026-03-25T10:05:00.000Z",
      },
      {
        id: "artifact_stdout_a",
        kind: "stdout",
        isPinned: true,
        sizeBytes: 8000,
        createdAt: "2026-03-25T10:10:00.000Z",
      },
      {
        id: "artifact_file_a",
        kind: "file",
        isPinned: true,
        sizeBytes: 220000,
        createdAt: "2026-03-24T10:10:00.000Z",
      },
      {
        id: "artifact_archive_a",
        kind: "archive",
        isPinned: true,
        sizeBytes: 560000,
        createdAt: "2026-03-23T10:10:00.000Z",
      },
    ],
    deliverables: [
      {
        id: "deliverable_bundle",
        title: "Example browser pack",
        summary: "Screenshots and json packaged together.",
        kind: "package",
        visibility: "public_material",
        sourceKind: "bundle",
        bundleItemArtifactIds: ["artifact_shot_a", "artifact_json_a", "artifact_stdout_a"],
        downloadCount: 8,
        lastDownloadedAt: "2026-03-26T03:00:00.000Z",
        updatedAt: "2026-03-25T03:00:00.000Z",
        packageBuiltAt: "2026-03-25T02:59:00.000Z",
        packageSizeBytes: 182000,
        packageCacheKey: "cache_bundle_a",
      },
      {
        id: "deliverable_external",
        title: "Public Notion page",
        summary: "External material.",
        kind: "deck",
        visibility: "public_material",
        sourceKind: "external_link",
        bundleItemArtifactIds: [],
        downloadCount: 3,
        lastDownloadedAt: "2026-03-25T05:00:00.000Z",
        updatedAt: "2026-03-25T01:00:00.000Z",
      },
      {
        id: "deliverable_artifact",
        title: "Generated memo",
        summary: "Direct artifact-backed document.",
        kind: "generated_document",
        visibility: "owner_only",
        sourceKind: "artifact",
        artifactId: "artifact_file_a",
        bundleItemArtifactIds: [],
        downloadCount: 1,
        lastDownloadedAt: null,
        updatedAt: "2026-03-24T09:00:00.000Z",
      },
      {
        id: "deliverable_stale_bundle",
        title: "Draft bundle",
        summary: "Needs packaging.",
        kind: "download",
        visibility: "owner_only",
        sourceKind: "bundle",
        bundleItemArtifactIds: ["artifact_archive_a"],
        downloadCount: 0,
        lastDownloadedAt: null,
        updatedAt: "2026-03-26T01:00:00.000Z",
      },
    ],
    oversizedBundleAttempts: 2,
  };
}

describe("buildRepresentativeDeliverableInsights", () => {
  it("aggregates deliverables by downloads, visibility, source kind, and kind", () => {
    const snapshot = buildRepresentativeDeliverableInsights(createSource());

    expect(snapshot.summary).toEqual({
      totalDeliverables: 4,
      publicMaterials: 2,
      totalDownloads: 12,
      bundlePackageDownloads: 8,
      pinnedArtifactsReused: 5,
    });
    expect(snapshot.byKind.find((row) => row.key === "package")).toMatchObject({
      count: 1,
      totalDownloads: 8,
    });
    expect(snapshot.bySourceKind.find((row) => row.key === "bundle")).toMatchObject({
      count: 2,
      totalDownloads: 8,
    });
    expect(snapshot.byVisibility.find((row) => row.key === "public_material")).toMatchObject({
      count: 2,
      totalDownloads: 11,
    });
    expect(snapshot.topDeliverables.mostDownloaded[0]).toMatchObject({
      id: "deliverable_bundle",
      downloadCount: 8,
    });
  });

  it("builds stable bundle preset membership instead of drifting with all pinned artifacts", () => {
    const preset = buildDeliverablePackagingPreset({
      key: "deck",
      representativeDisplayName: "Lin Founder Rep",
      artifacts: createSource().artifacts,
    });

    expect(preset.sourceKind).toBe("bundle");
    expect(preset.bundleItemArtifactIds).toEqual([
      "artifact_shot_a",
      "artifact_json_a",
      "artifact_stdout_a",
      "artifact_file_a",
    ]);
  });

  it("computes the same package cache key for the same package inputs", () => {
    const input = {
      representativeSlug: "lin-founder-rep",
      deliverableId: "deliverable_bundle",
      artifactIds: ["artifact_shot_a", "artifact_json_a"],
      artifactFingerprints: [
        {
          id: "artifact_shot_a",
          sha256: "sha-shot",
          sizeBytes: 140000,
          fileName: "screenshot.jpg",
        },
        {
          id: "artifact_json_a",
          sha256: "sha-json",
          sizeBytes: 12000,
          fileName: "payload.json",
        },
      ],
    };

    expect(computeDeliverablePackageCacheKey(input)).toBe(
      computeDeliverablePackageCacheKey({ ...input }),
    );
  });

  it("reports cached and stale package health separately", () => {
    const snapshot = buildRepresentativeDeliverableInsights(createSource());

    expect(snapshot.packageHealth).toEqual({
      cachedPackageCount: 1,
      stalePackageCount: 1,
      oversizedBundleAttempts: 2,
    });
  });

  it("returns a stable default structure when there are no deliverables or downloads", () => {
    const snapshot = buildRepresentativeDeliverableInsights({
      representative: {
        slug: "lin-founder-rep",
        displayName: "Lin Founder Rep",
      },
      artifacts: [],
      deliverables: [],
    });

    expect(snapshot.summary).toEqual({
      totalDeliverables: 0,
      publicMaterials: 0,
      totalDownloads: 0,
      bundlePackageDownloads: 0,
      pinnedArtifactsReused: 0,
    });
    expect(snapshot.topDeliverables.mostDownloaded).toEqual([]);
    expect(snapshot.artifactReuseHotspots).toEqual([]);
    expect(snapshot.packageHealth.cachedPackageCount).toBe(0);
  });
});

describe("getRepresentativePublicDeliverables", () => {
  it("falls back to an empty demo deliverable list when DATABASE_URL is unavailable", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(getRepresentativePublicDeliverables("lin-founder-rep")).resolves.toMatchObject({
        representative: {
          slug: "lin-founder-rep",
        },
        deliverables: [],
      });
    } finally {
      if (typeof previousDatabaseUrl === "string") {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });
});
