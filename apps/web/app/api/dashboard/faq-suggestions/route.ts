import { NextResponse } from "next/server";
import { z } from "zod";
import { generateFaqSuggestions } from "@delegate/model-runtime";
import { getFaqKnowledgeAssets, KnowledgeLibraryError } from "@delegate/web-data";
import { dashboardAuthErrorResponse, requireDashboardApiOwnerSession } from "../auth";
import { withPrivateNoStore } from "../../private-response";

const MAX_IDS = 20, MAX_SOURCES = 5, SOURCE_CHARS = 2000, TOTAL_FAQS = 50;
const schema = z.object({
  assetIds: z.array(z.string().trim().min(1).max(100)).max(MAX_IDS),
  count: z.number().int().min(1).default(3),
  representative: z.object({ name: z.string().trim().max(180).optional(), description: z.string().refine(s => Array.from(s).length <= 2000) }).optional(),
}).strict().refine(x => new Set(x.assetIds).size === x.assetIds.length);

export async function POST(request: Request) {
  try {
    const session = await requireDashboardApiOwnerSession();
    if (!session?.ownerId?.trim()) return reply({ error: "Authentication required." }, 401);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return reply({ error: "Invalid request." }, 400);
    const { assetIds, count, representative } = parsed.data;
    let assets;
    try { assets = await getFaqKnowledgeAssets(session.ownerId, assetIds, MAX_SOURCES); }
    catch (error) {
      if (error instanceof KnowledgeLibraryError && error.statusCode === 400) return reply({ error: "One or more knowledge assets are unavailable." }, 400);
      throw error;
    }
    const selected = assets.slice(0, MAX_SOURCES);
    const usable = selected.filter(a => a.extractedText?.trim());
    const maxCount = usable.length ? Math.floor(TOTAL_FAQS / usable.length) : TOTAL_FAQS;
    if (count > maxCount) return reply({ error: "Requested count exceeds the limit.", maxCount }, 400);
    const description = representative?.description.trim() ?? "";
    const shortDescription = Array.from(description).slice(0, 500).join("");
    const context = representative && (representative.name?.trim() || shortDescription) ? { name: representative.name?.trim() || "代表", description: shortDescription } : undefined;
    const results = await mapLimited(selected, async (asset) => {
      const text = asset.extractedText?.trim() ?? "";
      const base = { id: asset.id, title: asset.title, updatedAt: asset.updatedAt.toISOString(), processingVersion: asset.processingVersion };
      if (!text) return { ...base, status: "no_usable_sources", usage: "skipped", suggestions: [] };
      try {
      const result = await generateFaqSuggestions({ sources: [{ id: asset.id, title: asset.title, text }], count, ...(context ? { representative: context } : {}) }, { perSourceLimit: SOURCE_CHARS, requireSourceCitation: true });
      return { ...base, status: result.status, usage: result.sources[0]?.status, suggestions: result.suggestions, ...(result.reason ? { reason: result.reason } : {}) };
      } catch (error) { return { ...base, status: error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "timeout" : "model_failure", suggestions: [], reason: "模型请求失败。" }; }
    });
    const good = results.filter(r => r.status === "success" || r.status === "insufficient_material").length;
    const attempted = results.filter(r => r.status !== "no_usable_sources").length;
    const status = attempted === 0 ? "no_usable_sources" : good === attempted ? "success" : good ? "partial_success" : "failed";
    const suggestions = results.flatMap(r => r.suggestions);
    if (shortDescription) suggestions.unshift({ question: "当前代表有什么功能或作用？", answer: shortDescription, sourceIds: ["representative"] });
    return reply({ status, suggestions, results, ignoredAssetIds: assetIds.slice(MAX_SOURCES), descriptionTruncated: Array.from(description).length > 500 });
  } catch (error) {
    const authResponse = dashboardAuthErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("FAQ request failed", { kind: error instanceof Error ? error.name : "unknown" });
    return reply({ error: "Unable to process FAQ request." }, 500);
  }
}
function reply(body: unknown, status = 200) { return withPrivateNoStore(NextResponse.json(body, { status })); }

async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const configured = Number(process.env.FAQ_GENERATION_CONCURRENCY ?? MAX_SOURCES);
  const limit = Number.isInteger(configured) && configured > 0 ? Math.min(configured, MAX_SOURCES) : MAX_SOURCES;
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await fn(items[index]!); }
  }));
  return results;
}
