import { createRequire } from "node:module";

export type Vault = { id: string; name: string; encrypted: boolean };
export type Note = { id: string; path: string; size: number; modifiedAt: number };
export type UnlockedVault = {
  id: string; host: string; version: number; salt: string; key: string;
};
export type Login = { token: string; email: string; name: string };
type RemoteVault = {
  id: string; name: string; host: string; salt: string;
  encryption_version: number; password?: string;
};
type Entry = { uid: number; path: string; size: number; mtime: number; folder: boolean; deleted: boolean };
type WireMessage = { op?: string; size?: number; pieces?: number; deleted?: boolean };
type Client = {
  connect: (url: string, token: string, id: string, version: number, initial: boolean,
    device: string, ready: () => void, entry: (entry: Entry) => void) => Promise<void>;
  disconnect: () => void;
  onDisconnect: (() => void) | null;
  send: (message: WireMessage) => void;
  sendBinary: (data: unknown) => void;
  request: (message: WireMessage) => Promise<WireMessage>;
  pull: (uid: number) => Promise<ArrayBuffer | null>;
};
type Headless = {
  login: (email: string, password: string, mfa: string) => Promise<Login>;
  logout: (token: string) => Promise<unknown>;
  listVaults: (token: string) => Promise<{ vaults: RemoteVault[]; shared: RemoteVault[] }>;
  deriveKey: (password: string, salt: string) => Promise<ArrayBuffer>;
  keyHash: (key: ArrayBuffer, salt: string, version: number) => Promise<string>;
  accessVault: (token: string, id: string, hash: string, host: string, version: number) => Promise<unknown>;
  encryption: (version: number, key: ArrayBuffer, salt: string) => Promise<unknown>;
  encodeKey: (key: ArrayBuffer) => string;
  decodeKey: (key: string) => ArrayBuffer;
  Client: new (encryption: unknown) => Client;
};

const require = createRequire(import.meta.url);
// This is the only module that knows the patched upstream interface.
let upstream: Headless | undefined;
function headless(): Headless {
  upstream ??= require("obsidian-headless") as Headless;
  if (!upstream.Client || !upstream.listVaults) throw new SyncError("UNAVAILABLE");
  return upstream;
}

export type SyncErrorCode = "MFA_REQUIRED" | "AUTH_FAILED" | "LOCKED" | "NOT_FOUND" |
  "EXPIRED" | "CHANGED" | "LIMIT" | "UNAVAILABLE" | "NETWORK";
export class SyncError extends Error {
  constructor(public readonly code: SyncErrorCode) { super(code); }
}

function classify(error: unknown): never {
  if (error instanceof SyncError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/2FA code/i.test(message)) throw new SyncError("MFA_REQUIRED");
  if (/Wrong vault key/i.test(message)) throw new SyncError("LOCKED");
  if (/token|unauthorized|not logged|session|authenticate/i.test(message)) throw new SyncError("EXPIRED");
  // Never return raw provider responses, credentials, or stack traces to consumers.
  throw new SyncError("NETWORK");
}

async function remoteVaults(token: string) {
  const result = await headless().listVaults(token);
  return [...result.vaults, ...result.shared];
}

export async function login(email: string, password: string, mfa = ""): Promise<Login> {
  try { return await headless().login(email, password, mfa); }
  catch (error) {
    if (error instanceof Error && /2FA code/i.test(error.message)) throw new SyncError("MFA_REQUIRED");
    throw new SyncError("AUTH_FAILED");
  }
}
export async function logout(token: string): Promise<void> {
  await headless().logout(token).catch(() => undefined);
}
export async function listVaults(token: string): Promise<Vault[]> {
  try {
    return (await remoteVaults(token)).map(v => ({ id: v.id, name: v.name, encrypted: !v.password }));
  } catch (error) { return classify(error); }
}
export async function unlock(token: string, id: string, password: string): Promise<UnlockedVault> {
  try {
    const remote = (await remoteVaults(token)).find(v => v.id === id);
    if (!remote) throw new SyncError("NOT_FOUND");
    const secret = remote.password || password;
    if (!secret) throw new SyncError("LOCKED");
    const key = await headless().deriveKey(secret, remote.salt);
    const hash = await headless().keyHash(key, remote.salt, remote.encryption_version);
    await headless().accessVault(token, id, hash, remote.host, remote.encryption_version);
    return { id, host: remote.host, version: remote.encryption_version, salt: remote.salt, key: headless().encodeKey(key) };
  } catch (error) { return classify(error); }
}

const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_BYTES = 40 * 1024 * 1024;
function isNote(path: string) {
  return path.length <= 1024 && /\.(md|markdown)$/i.test(path) && !/[\\:]/.test(path) &&
    path.split("/").every(p => p && !p.startsWith(".") && !["node_modules", "$recycle.bin"].includes(p.toLowerCase()));
}

// A short-lived, read-only connection. No stock synchronizer or local vault is created.
export async function readVault(
  token: string, vault: UnlockedVault, selected: readonly string[] = [],
): Promise<{ notes: Note[]; files: { id: string; path: string; text: string }[] }> {
  if (selected.length > 1000 || new Set(selected).size !== selected.length) throw new SyncError("LIMIT");
  if (!/^[a-z0-9.-]+\.obsidian\.md$/i.test(vault.host)) throw new SyncError("UNAVAILABLE");
  const api = headless();
  const client = new api.Client(await api.encryption(vault.version, api.decodeKey(vault.key), vault.salt));
  const entries = new Map<string, Entry>();
  let fail!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => { fail = reject; });
  // Attach a handler before starting the connection; callbacks can reject immediately.
  void failed.catch(() => undefined);
  const timer = setTimeout(() => { fail(new SyncError("NETWORK")); client.disconnect(); }, 90_000);
  const send = client.send.bind(client);
  client.send = message => {
    if (!["init", "ping", "pull"].includes(message.op ?? "")) throw new SyncError("UNAVAILABLE");
    send(message);
  };
  client.sendBinary = () => { throw new SyncError("UNAVAILABLE"); };
  const request = client.request.bind(client);
  client.request = async message => {
    const result = await request(message);
    // Check before upstream allocates the body buffer.
    if (message.op === "pull" && !result.deleted &&
      (!Number.isSafeInteger(result.size) || result.size! < 0 || result.size! > MAX_NOTE_BYTES + 128 ||
       !Number.isSafeInteger(result.pieces) || result.pieces! < 0 || result.pieces! > 2)) throw new SyncError("LIMIT");
    return result;
  };
  client.onDisconnect = () => fail(new SyncError("NETWORK"));
  try {
    let ready!: () => void;
    const listed = new Promise<void>(resolve => { ready = resolve; });
    await Promise.race([client.connect(`wss://${vault.host}`, token, vault.id, 0, true,
      "Delegate read-only import", ready, entry => {
        if (entries.size >= 50_000) { fail(new SyncError("LIMIT")); client.disconnect(); return; }
        entries.set(entry.path, entry);
      }), failed]);
    await Promise.race([listed, failed]);
    const notes = [...entries.values()].filter(e => !e.deleted && !e.folder && isNote(e.path))
      .map(e => ({ id: String(e.uid), path: e.path, size: e.size, modifiedAt: e.mtime }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const requested = selected.map(id => notes.find(note => note.id === id));
    if (requested.some(note => !note)) throw new SyncError("CHANGED");
    if (requested.reduce((sum, note) => sum + note!.size, 0) > MAX_BATCH_BYTES) throw new SyncError("LIMIT");
    const files: { id: string; path: string; text: string }[] = [];
    let totalBytes = 0;
    for (const note of requested) {
      const body = await Promise.race([client.pull(Number(note!.id)), failed]);
      if (!body) throw new SyncError("CHANGED");
      totalBytes += body.byteLength;
      if (body.byteLength > MAX_NOTE_BYTES || totalBytes > MAX_BATCH_BYTES) throw new SyncError("LIMIT");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      if (text.length > 400_000) throw new SyncError("LIMIT");
      files.push({ id: note!.id, path: note!.path, text });
    }
    return { notes, files };
  } catch (error) { return classify(error); }
  finally {
    clearTimeout(timer);
    client.onDisconnect = null;
    client.disconnect();
  }
}
