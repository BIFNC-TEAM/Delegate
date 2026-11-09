import { parseArgs } from "node:util";
import * as fs from "node:fs/promises";
import path from "node:path";
import { seedreamConfig, seedreamModelConfig } from "../packages/model-runtime/src/seedream/index";
import { SLOTS, approveMaster, configurePricing, executeSlot, preparePilot, readRun, reconcileReceipt, sha256, unlockStoppedPilot, type Slot } from "./lib/seedream-avatar-pilot";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  run: { type: "string" }, references: { type: "string" }, slot: { type: "string" }, sha256: { type: "string" },
  "height-cm": { type: "string" }, "budget-cny": { type: "string" }, "ceiling-cny": { type: "string" },
  "pricing-note": { type: "string" }, execute: { type: "boolean", default: false },
  "retry-rejected": { type: "boolean", default: false }, help: { type: "boolean", default: false },
} });
function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing --${name}`); return value;
}
function slot(value: string | undefined): Slot {
  if (!SLOTS.includes(value as Slot)) throw new Error(`Choose a slot: ${SLOTS.join(", ")}`); return value as Slot;
}
function help() {
  console.log(`Seedream avatar pilot (server-side, no public endpoint)
prepare --run DIR --references PACK_DIR [--height-cm 170] [--budget-cny 30]
status --run DIR
pricing --run DIR --ceiling-cny VERIFIED_UPPER_BOUND --pricing-note SOURCE_AND_DATE
master --run DIR --slot master-1|master-2 --execute
approve --run DIR --slot master-1|master-2 --sha256 REVIEWED_IMAGE_SHA256
views --run DIR [--slot front|back|left|right] --execute
reconcile --run DIR --slot SLOT   (only from an already saved, matching receipt)
unlock --run DIR                 (only if the lock's process no longer exists)

Generation uses ARK_API_KEY, SEEDREAM_MODEL_ID, SEEDREAM_ENABLED=true.
For ep-* endpoint IDs also set SEEDREAM_MODEL_FAMILY.
No automatic retries; a rejected request requires --retry-rejected.
The recorded request price is an operator-verified conservative upper bound,
not a live billing quote. Unknown outcomes keep their full budget reservation.`);
}
async function main() {
  const command = positionals[0];
  if (values.help || !command) { help(); return; }
  const directory = path.resolve(required(values.run, "run"));
  if (command === "prepare") {
    const pack = await fs.realpath(required(values.references, "references"));
    const manifest = JSON.parse(await fs.readFile(path.join(pack, "manifest.json"), "utf8"));
    if (!Array.isArray(manifest.referenceOrder) || manifest.referenceOrder.length !== 4) throw new Error("Reference pack must have four ordered images.");
    const sources: string[] = [];
    for (const reference of manifest.referenceOrder) {
      if (typeof reference.file !== "string" || path.basename(reference.file) !== reference.file) throw new Error("Invalid reference filename.");
      const source = await fs.realpath(path.join(pack, reference.file));
      if (!source.startsWith(pack + path.sep) || (await fs.stat(source)).size > 12*1024*1024) throw new Error("Invalid reference path or size.");
      if (sha256(await fs.readFile(source)) !== reference.sha256) throw new Error("Reference pack hash mismatch.");
      sources.push(source);
    }
    const run = await preparePilot(directory, sources, Number(values["height-cm"] ?? manifest.heightCm ?? 170), Number(values["budget-cny"] ?? 30));
    console.log(JSON.stringify({ runId: run.id, directory, references: 4, budgetCny: run.budgetCents/100, submitted: false }));
  } else if (command === "status") {
    const run = await readRun(directory);
    console.log(JSON.stringify({ directory, runId: run.id, budgetCny: run.budgetCents/100, reservedCny: run.reservedCents/100,
      calls: run.calls, pricing: run.pricing, approvedMaster: run.approvedMaster,
      configuration: { keyConfigured: Boolean(process.env.ARK_API_KEY?.trim()), modelConfigured: Boolean(process.env.SEEDREAM_MODEL_ID?.trim()), enabled: process.env.SEEDREAM_ENABLED === "true" },
      steps: Object.fromEntries(SLOTS.map(name => [name, { status: run.steps[name].status,
        output: run.steps[name].output ? { ...run.steps[name].output, file: path.join(directory, run.steps[name].output!.file) } : null,
        errorCode: run.steps[name].errorCode ?? null }])) }, null, 2));
  } else if (command === "pricing") {
    await configurePricing(directory, seedreamModelConfig(), Number(required(values["ceiling-cny"], "ceiling-cny")), required(values["pricing-note"], "pricing-note"));
    console.log("Pricing reservation recorded; no generation submitted.");
  } else if (command === "approve") {
    const name = slot(values.slot);
    if (name !== "master-1" && name !== "master-2") throw new Error("Only a master can be approved.");
    await approveMaster(directory, name, required(values.sha256, "sha256"));
    console.log("Reviewed master approved; no view generation submitted.");
  } else if (command === "master" || command === "views") {
    if (!values.execute) throw new Error("Add --execute only when the provider, photo transmission and cost have been authorized.");
    const names = command === "master" ? [slot(values.slot ?? "master-1")] : values.slot ? [slot(values.slot)] : SLOTS.slice(2);
    if (names.some(name => command === "master" ? !name.startsWith("master-") : name.startsWith("master-"))) throw new Error("Slot does not match command.");
    const config = seedreamConfig();
    for (const name of names) {
      const output = await executeSlot(directory, name, config, { retryRejected: values["retry-rejected"] });
      console.log(JSON.stringify({ slot: name, ...output, file: path.join(directory, output.file) }));
    }
  } else if (command === "reconcile") {
    await reconcileReceipt(directory, slot(values.slot)); console.log("Saved receipt reconciled; no network request made.");
  } else if (command === "unlock") {
    await unlockStoppedPilot(directory); console.log("Stopped process lock archived; uncertain requests remain blocked.");
  } else { throw new Error("Unknown command. Use --help."); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Seedream pilot failed."); process.exitCode = 1; });
