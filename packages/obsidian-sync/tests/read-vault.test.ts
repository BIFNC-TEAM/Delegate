import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readVault, type UnlockedVault } from "../src/index";

const api = createRequire(import.meta.url)("obsidian-headless");
const vault: UnlockedVault = { id: "test-vault", host: "sync-01.obsidian.md", version: 3, salt: "test", key: "test" };
let requests: string[] = [];
let oversized = false;
let attemptWrite = false;
let closed = 0;
class FakeClient {
  onDisconnect: (() => void) | null = null;
  send(_message: { op: string }) {}
  sendBinary(_data: unknown) {}
  async request(message: { op: string }) {
    this.send(message); return { size: oversized ? 100_000_000 : 10, pieces: 1 };
  }
  async connect(_url: string, _token: string, _id: string, _v: number, _initial: boolean, _device: string,
    ready: () => void, entry: (e: object) => void) {
    this.send({ op: attemptWrite ? "push" : "init" });
    entry({ uid: 1, path: "商品/介绍.md", size: 50, mtime: 1, folder: false, deleted: false });
    entry({ uid: 2, path: "成本.md", size: 30, mtime: 1, folder: false, deleted: false });
    entry({ uid: 3, path: ".obsidian/config.md", size: 30, mtime: 1, folder: false, deleted: false });
    entry({ uid: 4, path: "photo.png", size: 30, mtime: 1, folder: false, deleted: false });
    ready();
  }
  async pull(uid: number) {
    requests.push(String(uid));
    await this.request({ op: "pull" });
    return new TextEncoder().encode("商品介绍 [[成本]]").buffer;
  }
  disconnect() { closed++; }
}
beforeEach(() => {
  requests = []; oversized = false; attemptWrite = false; closed = 0;
  vi.spyOn(api, "encryption").mockResolvedValue({});
  vi.spyOn(api, "decodeKey").mockReturnValue(new ArrayBuffer(32));
  vi.spyOn(api, "Client").mockImplementation(function () { return new FakeClient(); });
});
afterEach(() => vi.restoreAllMocks());

describe("read-only Headless adapter", () => {
  it("lists only note metadata without any pulls", async () => {
    const result = await readVault("token", vault);
    expect(result.notes.map(n => n.path)).toEqual(["商品/介绍.md", "成本.md"].sort((a, b) => a.localeCompare(b)));
    expect(result.files).toEqual([]);
    expect(requests).toEqual([]);
    expect(closed).toBe(1);
  });
  it("downloads only explicit selections, never references", async () => {
    const result = await readVault("token", vault, ["1"]);
    expect(requests).toEqual(["1"]);
    expect(result.files[0]?.text).toContain("[[成本]]");
  });
  it("rejects stale identifiers before any body is downloaded", async () => {
    await expect(readVault("token", vault, ["1", "999"])).rejects.toMatchObject({ code: "CHANGED" });
    expect(requests).toEqual([]);
    expect(closed).toBe(1);
  });
  it("cannot download hidden settings or non-note files", async () => {
    await expect(readVault("token", vault, ["3"])).rejects.toMatchObject({ code: "CHANGED" });
    await expect(readVault("token", vault, ["4"])).rejects.toMatchObject({ code: "CHANGED" });
    expect(requests).toEqual([]);
  });
  it("blocks write operations even if upstream tries to send one", async () => {
    attemptWrite = true;
    await expect(readVault("token", vault)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(closed).toBe(1);
  });
  it("rejects oversized responses before the upstream body allocation", async () => {
    oversized = true;
    await expect(readVault("token", vault, ["1"])).rejects.toMatchObject({ code: "LIMIT" });
    expect(closed).toBe(1);
  });
  it("rejects non-Obsidian hosts and duplicate selections", async () => {
    await expect(readVault("token", { ...vault, host: "127.0.0.1" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(readVault("token", vault, ["1", "1"])).rejects.toMatchObject({ code: "LIMIT" });
  });
});
