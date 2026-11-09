import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  avatarMasterPrompt, avatarViewPrompt, generateSeedreamImage, imageMime, SeedreamError,
  type AvatarView, type GeneratedImage, type ImageInput, type SeedreamConfig,
} from "../../packages/model-runtime/src/seedream/index";
import { normalizeAvatarReference, inspectGeneratedAvatarReference } from "../../packages/web-data/src/avatar-reference-images";

export const SLOTS = ["master-1", "master-2", "front", "back", "left", "right"] as const;
export type Slot = typeof SLOTS[number];
type Output = { file: string; sha256: string; mime: ImageInput["mime"]; width: number; height: number; requestId: string | null };
type Step = { status: "ready" | "running" | "succeeded" | "rejected" | "unknown"; attemptId?: string; inputDigest?: string; prompt?: string; output?: Output; errorCode?: string };
export type PilotRun = {
  schemaVersion: 1; id: string; heightCm: number; budgetCents: number; reservedCents: number; calls: number;
  references: { file: string; sha256: string }[];
  pricing: { model: string; family: SeedreamConfig["family"]; ceilingCents: number; note: string } | null;
  approvedMaster: { slot: "master-1" | "master-2"; sha256: string } | null;
  steps: Record<Slot, Step>;
};
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function cents(amount: number): number {
  const value = Math.round(amount * 100);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(value) || value <= 0 || Math.abs(value / 100 - amount) > 1e-6) throw new Error("Use a positive CNY amount with at most two decimals.");
  return value;
}
async function writeJson(file: string, value: unknown) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, file);
}
export async function readRun(directory: string): Promise<PilotRun> {
  const data = JSON.parse(await fs.readFile(path.join(directory, "run.json"), "utf8")) as PilotRun;
  if (data.schemaVersion !== 1 || !data.id || !Array.isArray(data.references) || data.references.length !== 4
      || !Number.isSafeInteger(data.calls) || data.calls < 0 || data.calls > 6
      || !Number.isSafeInteger(data.budgetCents) || data.budgetCents <= 0
      || !Number.isSafeInteger(data.reservedCents) || data.reservedCents < 0 || data.reservedCents > data.budgetCents
      || !SLOTS.every(slot => ["ready", "running", "succeeded", "rejected", "unknown"].includes(data.steps?.[slot]?.status))) {
    throw new Error("Invalid pilot state.");
  }
  if (data.pricing && (!Number.isSafeInteger(data.pricing.ceilingCents) || data.pricing.ceilingCents <= 0)) throw new Error("Invalid pricing state.");
  for (const slot of SLOTS) {
    const id = data.steps[slot].attemptId;
    if (id && !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid attempt ID.");
  }
  return data;
}
async function locked<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const lockPath = path.join(directory, ".lock");
  let lock;
  try { lock = await fs.open(lockPath, "wx", 0o600); }
  catch { throw new Error("Pilot is locked by another invocation. Use unlock only after confirming the previous process stopped."); }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return await action();
  }
  finally { await lock.close(); await fs.unlink(lockPath); }
}
async function verifiedFile(directory: string, file: string, hash: string): Promise<Buffer> {
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error("Invalid stored file path.");
  const base = await fs.realpath(directory); const target = await fs.realpath(path.join(directory, file));
  if (!target.startsWith(base + path.sep)) throw new Error("Stored file escaped pilot directory.");
  if ((await fs.stat(target)).size > 20 * 1024 * 1024) throw new Error("Stored image too large.");
  const bytes = await fs.readFile(target);
  if (sha256(bytes) !== hash || !imageMime(bytes)) throw new Error("Stored image hash/type mismatch.");
  return bytes;
}

export async function preparePilot(directory: string, sources: readonly string[], heightCm = 170, budgetCny = 30): Promise<PilotRun> {
  if (sources.length !== 4) throw new Error("Provide exactly four images: front face, two side faces, full body.");
  avatarMasterPrompt(heightCm);
  const budgetCents = cents(budgetCny);
  const normalized: Buffer[] = [];
  for (const source of sources) {
    if ((await fs.stat(source)).size > 12 * 1024 * 1024) throw new Error("Source image exceeds 12 MiB.");
    normalized.push(await normalizeAvatarReference(await fs.readFile(source)));
  }
  await fs.mkdir(path.dirname(path.resolve(directory)), { recursive: true });
  await fs.mkdir(directory, { mode: 0o700 }); // Never overwrite or silently re-prepare an existing run.
  await fs.mkdir(path.join(directory, "inputs"), { mode: 0o700 });
  await fs.mkdir(path.join(directory, "results"), { mode: 0o700 });
  const references: PilotRun["references"] = [];
  for (const [index, bytes] of normalized.entries()) {
    const file = `inputs/${index + 1}.jpg`;
    await fs.writeFile(path.join(directory, file), bytes, { mode: 0o600 });
    references.push({ file, sha256: sha256(bytes) });
  }
  const run: PilotRun = { schemaVersion: 1, id: randomUUID(), heightCm, budgetCents,
    reservedCents: 0, calls: 0, references, pricing: null, approvedMaster: null,
    steps: Object.fromEntries(SLOTS.map(slot => [slot, { status: "ready" }])) as PilotRun["steps"] };
  await writeJson(path.join(directory, "run.json"), run);
  return run;
}

export async function configurePricing(directory: string, model: Pick<SeedreamConfig, "model" | "family">, ceilingCny: number, note: string) {
  return locked(directory, async () => {
    const run = await readRun(directory);
    if (run.calls || !note.trim() || note.length > 500) throw new Error("Pricing must be recorded before any call, with a verified pricing note.");
    run.pricing = { ...model, ceilingCents: cents(ceilingCny), note };
    if (run.pricing.ceilingCents > run.budgetCents) throw new Error("One request would exceed the total budget.");
    await writeJson(path.join(directory, "run.json"), run);
  });
}

export async function approveMaster(directory: string, slot: "master-1" | "master-2", expectedHash: string) {
  if (slot !== "master-1" && slot !== "master-2") throw new Error("Only a master can be approved.");
  return locked(directory, async () => {
    const run = await readRun(directory);
    if (SLOTS.slice(2).some(view => run.steps[view].status !== "ready")) throw new Error("Views have already started. Use a new run to change the approved master.");
    const step = run.steps[slot];
    if (step.status !== "succeeded" || !step.output || step.output.sha256 !== expectedHash) throw new Error("Approve the SHA-256 of a successfully generated master after reviewing it.");
    await verifiedFile(directory, step.output.file, expectedHash);
    run.approvedMaster = { slot, sha256: expectedHash };
    await writeJson(path.join(directory, "run.json"), run);
  });
}

export async function executeSlot(directory: string, slot: Slot, config: SeedreamConfig,
  options: { retryRejected?: boolean; generate?: typeof generateSeedreamImage } = {}): Promise<Output> {
  if (!SLOTS.includes(slot)) throw new Error("Unknown image slot.");
  return locked(directory, async () => {
    const run = await readRun(directory); const old = run.steps[slot];
    if (!run.pricing || run.pricing.model !== config.model || run.pricing.family !== config.family) throw new Error("Record verified pricing for this exact model before generation.");
    if (old.status === "succeeded" && old.output) {
      await verifiedFile(directory, old.output.file, old.output.sha256);
      return old.output;
    }
    if (old.status === "running" || old.status === "unknown") throw new Error("Previous outcome is uncertain. Reconcile a saved receipt or inspect the provider record; do not blindly retry.");
    if (old.status === "rejected" && !options.retryRejected) throw new Error("Use an explicit rejected-request retry after fixing the cause.");
    if (run.calls >= 6 || run.reservedCents + run.pricing.ceilingCents > run.budgetCents) throw new Error("Pilot request/budget limit reached.");
    const images: ImageInput[] = [];
    let prompt: string;
    if (slot.startsWith("master-")) {
      if (run.approvedMaster) throw new Error("A master has already been approved; use a new run for a new character candidate.");
      prompt = avatarMasterPrompt(run.heightCm);
    } else {
      const approval = run.approvedMaster;
      const output = approval && run.steps[approval.slot].output;
      if (!approval || !output || output.sha256 !== approval.sha256) throw new Error("Review and approve a master before generating views.");
      const bytes = await verifiedFile(directory, output.file, output.sha256);
      images.push({ bytes, mime: output.mime });
      prompt = avatarViewPrompt(slot as AvatarView);
    }
    for (const reference of run.references) {
      images.push({ bytes: await verifiedFile(directory, reference.file, reference.sha256), mime: "image/jpeg" });
    }
    const attemptId = randomUUID();
    const inputDigest = sha256(JSON.stringify({ model: config.model, family: config.family, prompt, images: images.map(i => sha256(i.bytes)) }));
    run.steps[slot] = { status: "running", attemptId, inputDigest, prompt };
    run.calls += 1; run.reservedCents += run.pricing.ceilingCents;
    await writeJson(path.join(directory, "run.json"), run); // Reserve before any paid side effect.
    try {
      const generated: GeneratedImage = await (options.generate ?? generateSeedreamImage)(config, prompt, images);
      const dimensions = await inspectGeneratedAvatarReference(generated.bytes);
      const file = `results/${slot}-${attemptId}.${dimensions.format === "png" ? "png" : "jpg"}`;
      const output: Output = { file, sha256: sha256(generated.bytes), mime: generated.mime,
        width: dimensions.width, height: dimensions.height, requestId: generated.requestId };
      await fs.writeFile(path.join(directory, file), generated.bytes, { mode: 0o600, flag: "wx" });
      await writeJson(path.join(directory, `results/${slot}-${attemptId}.json`), {
        schemaVersion: 1, runId: run.id, slot, attemptId, inputDigest, model: config.model, output,
        generatedImages: generated.generatedImages, at: new Date().toISOString(),
      });
      run.steps[slot] = { ...run.steps[slot], status: "succeeded", output };
      await writeJson(path.join(directory, "run.json"), run);
      return output;
    } catch (error) {
      const failure = error instanceof SeedreamError ? error : new SeedreamError("local_result_failure", "unknown", "Result could not be verified or persisted; budget remains reserved.");
      run.steps[slot] = { ...run.steps[slot], status: failure.outcome === "unknown" ? "unknown" : "rejected", errorCode: failure.code };
      await writeJson(path.join(directory, "run.json"), run);
      throw failure;
    }
  });
}

export async function reconcileReceipt(directory: string, slot: Slot) {
  if (!SLOTS.includes(slot)) throw new Error("Unknown image slot.");
  return locked(directory, async () => {
    const run = await readRun(directory); const step = run.steps[slot];
    if (!step.attemptId || !["running", "unknown"].includes(step.status)) throw new Error("No uncertain attempt to reconcile.");
    const receipt = JSON.parse(await fs.readFile(path.join(directory, `results/${slot}-${step.attemptId}.json`), "utf8"));
    if (receipt.runId !== run.id || receipt.slot !== slot || receipt.attemptId !== step.attemptId || receipt.inputDigest !== step.inputDigest) throw new Error("Receipt does not match the attempted request.");
    await verifiedFile(directory, receipt.output.file, receipt.output.sha256);
    run.steps[slot] = { ...step, status: "succeeded", output: receipt.output };
    await writeJson(path.join(directory, "run.json"), run);
  });
}
export async function unlockStoppedPilot(directory: string) {
  const file = path.join(directory, ".lock");
  const lock = JSON.parse(await fs.readFile(file, "utf8"));
  if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error("Invalid lock; inspect manually.");
  try { process.kill(lock.pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    await fs.rename(file, `${file}.stopped-${Date.now()}`);
    return;
  }
  throw new Error("The lock owner process is still running; not unlocking.");
}
