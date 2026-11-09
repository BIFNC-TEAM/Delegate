import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { approveMaster, configurePricing, executeSlot, preparePilot, readRun, reconcileReceipt } from "../lib/seedream-avatar-pilot";
import { SeedreamError, type GeneratedImage, type SeedreamConfig } from "../../packages/model-runtime/src/seedream/index";
const sharp = createRequire(new URL("../../packages/web-data/package.json", import.meta.url))("sharp");
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const config: SeedreamConfig = { apiKey: "SYNTHETIC_TEST_ONLY", model: "doubao-seedream-4-5-fixture", family: "4.5", timeoutMs: 1000 };
async function setup(budget = 30, ceiling = 5) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "delegate-seedream-fixture-")); directories.push(parent);
  const input = await sharp({ create: { width: 32, height: 48, channels: 3, background: "#abc" } }).png().toBuffer();
  const sources: string[] = [];
  for (let i=0;i<4;i++) { const f=path.join(parent, `${i}.png`); await fs.writeFile(f,input); sources.push(f); }
  const dir=path.join(parent,"run");await preparePilot(dir,sources,170,budget);
  await configurePricing(dir,config,ceiling,"Synthetic test ceiling; never a real price quote.");
  const output: GeneratedImage = { bytes: await sharp({ create: { width: 1024, height: 1536, channels: 3, background: "#abc" } }).png().toBuffer(), mime: "image/png", model: config.model, requestId: "fixture", generatedImages: 1 };
  return { dir, output };
}
describe("bounded Seedream avatar pilot", () => {
  it("requires reviewed master approval, pins its hash and labels each requested view", async () => {
    const { dir,output }=await setup(); const generate=vi.fn().mockResolvedValue(output);
    await expect(executeSlot(dir,"front",config,{generate})).rejects.toThrow("approve");
    expect(generate).not.toHaveBeenCalled();
    const master=await executeSlot(dir,"master-1",config,{generate});
    await expect(approveMaster(dir,"master-1","wrong-hash")).rejects.toThrow();
    await approveMaster(dir,"master-1",master.sha256);
    await executeSlot(dir,"front",config,{generate});
    expect(generate.mock.calls[0]![2]).toHaveLength(4);
    expect(generate.mock.calls[1]![2]).toHaveLength(5);
    expect(generate.mock.calls[1]![1]).toContain("正面，面向镜头");
    await expect(approveMaster(dir,"master-1",master.sha256)).rejects.toThrow("already started");
  });
  it("does not regenerate a successfully persisted slot", async () => {
    const {dir,output}=await setup(); const generate=vi.fn().mockResolvedValue(output);
    const first=await executeSlot(dir,"master-1",config,{generate});
    expect(await executeSlot(dir,"master-1",config,{generate})).toEqual(first);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await readRun(dir)).reservedCents).toBe(500);
  });
  it("reserves budget before a request and blocks exceeding it", async () => {
    const {dir,output}=await setup(5,5);
    const generate=vi.fn().mockImplementation(async()=>{expect((await readRun(dir)).reservedCents).toBe(500);return output;});
    await executeSlot(dir,"master-1",config,{generate});
    await expect(executeSlot(dir,"master-2",config,{generate})).rejects.toThrow("budget");
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("persists unknown outcomes and never retries them, even with rejected-retry enabled", async () => {
    const {dir}=await setup();const generate=vi.fn().mockRejectedValue(new SeedreamError("timeout","unknown","fixture timeout"));
    await expect(executeSlot(dir,"master-1",config,{generate})).rejects.toThrow();
    const state=await readRun(dir);expect(state.steps['master-1'].status).toBe('unknown');expect(state.reservedCents).toBe(500);
    await expect(executeSlot(dir,"master-1",config,{generate,retryRejected:true})).rejects.toThrow("uncertain");
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("prevents concurrent invocations from double submitting", async () => {
    const {dir,output}=await setup();let release!: (v: GeneratedImage)=>void;let entered!: ()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve;});
    const generate=vi.fn().mockImplementation(async()=>{entered();return new Promise<GeneratedImage>(resolve=>{release=resolve;});});
    const first=executeSlot(dir,"master-1",config,{generate});await ready;
    await expect(executeSlot(dir,"master-1",config,{generate})).rejects.toThrow("locked");
    release(output);await first;expect(generate).toHaveBeenCalledTimes(1);
  });
  it("reconciles a saved result receipt after interruption without another provider call", async () => {
    const {dir,output}=await setup();const generate=vi.fn().mockResolvedValue(output);
    const original=await executeSlot(dir,"master-1",config,{generate});
    const state=await readRun(dir);state.steps['master-1'].status='running';delete state.steps['master-1'].output;
    await fs.writeFile(path.join(dir,'run.json'),JSON.stringify(state));
    await reconcileReceipt(dir,'master-1');expect((await readRun(dir)).steps['master-1'].output).toEqual(original);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("rejects changed references before reserving budget or sending photos", async () => {
    const {dir,output}=await setup();const generate=vi.fn().mockResolvedValue(output);
    await fs.appendFile(path.join(dir,'inputs/1.jpg'),'tampered');
    await expect(executeSlot(dir,'master-1',config,{generate})).rejects.toThrow("hash");
    expect((await readRun(dir)).calls).toBe(0);expect(generate).not.toHaveBeenCalled();
  });
});
