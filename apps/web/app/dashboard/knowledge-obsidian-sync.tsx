"use client";

import type { ObsidianReadResult } from "./knowledge-obsidian-types";
import { useEffect, useMemo, useRef, useState } from "react";
import { ObsidianNoteTree, buildObsidianNoteTree } from "./knowledge-obsidian-note-tree";
import { KnowledgeObsidianSelection } from "./knowledge-obsidian-selection";

type Connection = { id: string; email: string; expiresAt: string };
type Vault = { id: string; name: string; encrypted: boolean; unlocked: boolean };
type Note = { id: string; path: string; size: number };
type Response = {
  connection?: Connection | null; vaults?: Vault[]; notes?: Note[];
  files?: { id: string; path: string; text: string }[]; code?: string; error?: string;
};
export function KnowledgeObsidianSync({ activeSlug, zh, disabled, onRead, onBusyChange }: {
  activeSlug: string; zh: boolean; disabled: boolean;
  onRead: (result: ObsidianReadResult) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [vaultId, setVaultId] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfa, setMfa] = useState("");
  const [needsMfa, setNeedsMfa] = useState(false);
  const [vaultPassword, setVaultPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const vault = vaults.find(item => item.id === vaultId);
  const locked = disabled || busy;
  const tree = useMemo(() => buildObsidianNoteTree(notes), [notes]);

  async function request(input: object, signal: AbortSignal) {
    const response = await fetch("/api/dashboard/obsidian-sync", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Delegate-Representative": activeSlug },
      body: JSON.stringify(input), signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    const data = await response.json() as Response;
    if (!response.ok) {
      if (data.code === "MFA_REQUIRED") setNeedsMfa(true);
      if (data.code === "EXPIRED") { setConnection(null); setVaults([]); setNotes([]); setSelected(new Set()); }
      throw new Error(data.error || (zh ? "读取失败，请重试。" : "Unable to read. Please retry."));
    }
    return data;
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true); setError(""); busyCallback.current(true);
    try { await action(abort.signal); }
    catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Request failed."); }
    finally {
      if (controller.current === abort && !abort.signal.aborted) { setBusy(false); busyCallback.current(false); }
    }
  }
  useEffect(() => {
    void run(async signal => {
      const result = await request({ action: "status" }, signal);
      setConnection(result.connection ?? null);
      if (result.connection) {
        const resultVaults = await request({ action: "vaults", connectionId: result.connection.id }, signal);
        setVaults(resultVaults.vaults ?? []);
      }
      setLoaded(true);
    });
    return () => { controller.current?.abort(); busyCallback.current(false); };
    // Reload only for a different workspace. Event handlers use the current state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlug]);

  async function connect() {
    await run(async signal => {
      const result = await request({ action: "connect", email, password, mfa }, signal);
      setPassword(""); setMfa(""); setNeedsMfa(false);
      setConnection(result.connection ?? null);
      if (result.connection) {
        setVaults((await request({ action: "vaults", connectionId: result.connection.id }, signal)).vaults ?? []);
      }
    });
  }
  async function openVault(id: string) {
    setVaultId(id); setNotes([]); setSelected(new Set()); setVaultPassword("");
    const next = vaults.find(v => v.id === id);
    if (!next || !connection || (next.encrypted && !next.unlocked)) return;
    await run(async signal => {
      if (!next.unlocked) await request({ action: "unlock", connectionId: connection.id, vaultId: id, password: "" }, signal);
      setVaults(current => current.map(v => v.id === id ? { ...v, unlocked: true } : v));
      setNotes((await request({ action: "notes", connectionId: connection.id, vaultId: id }, signal)).notes ?? []);
    });
  }
  function select(ids: string[], checked: boolean) {
    setSelected(current => {
      const next = new Set(current);
      for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
      return next;
    });
  }
  async function readSelected() {
    if (!connection || !vault) return;
    await run(async signal => {
      const result = await request({ action: "download", connectionId: connection.id, vaultId, selected: [...selected] }, signal);
      signal.throwIfAborted();
      // A separate root per vault preserves relative references and prevents cross-vault matches.
      const root = `sync-${vaultId}`;
      onRead({
        files: (result.files ?? []).map(file => ({
          path: `${root}/${file.path}`, file: new File([file.text], file.path.split("/").pop()!, { type: "text/markdown" }),
        })),
        availablePaths: (result.notes ?? []).map(note => `${root}/${note.path}`),
      });
      setSelected(new Set());
    });
  }

  return <section className="knowledge-obsidian-sync" aria-label="Obsidian Sync" aria-busy={busy}>
    <p>{zh ? "连接保留 7 天。仅下载您选择的笔记，引用笔记需另行选择；导入后不持续同步。" : "Connections last 7 days. Only selected notes are downloaded, including references you explicitly select. Imports do not stay in sync."}</p>
    {!loaded ? null : !connection ? <fieldset className="knowledge-sync-connect" disabled={locked}>
      <legend>{zh ? "连接 Obsidian 账号" : "Connect your Obsidian account"}</legend>
      <label className="knowledge-form-field"><span>{zh ? "Obsidian 账号邮箱" : "Obsidian email"}</span><input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} /></label>
      <label className="knowledge-form-field"><span>{zh ? "账号密码" : "Account password"}</span><input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
      {needsMfa ? <label className="knowledge-form-field"><span>{zh ? "两步验证验证码" : "Verification code"}</span><input autoComplete="one-time-code" inputMode="numeric" value={mfa} onChange={e => setMfa(e.target.value)} /></label> : null}
      <button className="knowledge-sync-primary" type="button" disabled={!email || !password || !loaded} onClick={() => void connect()}>{zh ? "连接 Obsidian" : "Connect Obsidian"}</button>
    </fieldset> : <>
      <div className="knowledge-sync-account"><div><span className="knowledge-sync-connected">{zh ? "已连接" : "Connected"}</span><strong>{connection.email}</strong><small>{zh ? "连接到期：" : "Expires: "}{new Date(connection.expiresAt).toLocaleString()}</small></div>
        <button type="button" disabled={locked} onClick={() => void run(async signal => {
          await request({ action: "disconnect", connectionId: connection.id }, signal);
          setConnection(null); setVaults([]); setVaultId(""); setNotes([]); setSelected(new Set()); setVaultPassword("");
        })}>{zh ? "断开连接" : "Disconnect"}</button>
      </div>
      <div className="knowledge-sync-vault-row">
      <label className="knowledge-form-field"><span>{zh ? "笔记库" : "Vault"}</span><select disabled={locked} value={vaultId} onChange={e => void openVault(e.target.value)}>
        <option value="">{zh ? "请选择笔记库" : "Choose a vault"}</option>
        {vaults.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select></label>
      <button type="button" disabled={locked} onClick={() => void run(async signal => {
        setVaults((await request({ action: "vaults", connectionId: connection.id }, signal)).vaults ?? []);
      })}>{zh ? "刷新笔记库" : "Refresh vaults"}</button>
      </div>
      {!vaults.length ? <p>{zh ? "账号中没有可访问的 Sync 笔记库。" : "No accessible Sync vaults."}</p> : null}
      {vault?.encrypted && !vault.unlocked ? <fieldset className="knowledge-sync-unlock" disabled={locked}>
        <legend>{zh ? "解锁加密笔记库" : "Unlock encrypted vault"}</legend>
        <label className="knowledge-form-field"><span>{zh ? "笔记库独立密码（不是账号密码）" : "Vault encryption password (not your account password)"}</span><input type="password" autoComplete="off" value={vaultPassword} onChange={e => setVaultPassword(e.target.value)} /></label>
        <button className="knowledge-sync-primary" type="button" disabled={!vaultPassword} onClick={() => void run(async signal => {
          await request({ action: "unlock", connectionId: connection.id, vaultId, password: vaultPassword }, signal);
          setVaultPassword(""); setVaults(current => current.map(v => v.id === vaultId ? { ...v, unlocked: true } : v));
          setNotes((await request({ action: "notes", connectionId: connection.id, vaultId }, signal)).notes ?? []);
        })}>{zh ? "解锁笔记库" : "Unlock vault"}</button>
      </fieldset> : null}
      {vault?.unlocked ? <>
        <KnowledgeObsidianSelection zh={zh} disabled={locked} selectedCount={selected.size} totalCount={notes.length} onSelectAll={checked => select(notes.map(n => n.id), checked)}>
          <ObsidianNoteTree node={tree} selected={selected} select={select} />
          {!notes.length && !busy ? <p>{zh ? "没有可导入的 Markdown 笔记。" : "No Markdown notes to import."}</p> : null}
        </KnowledgeObsidianSelection>
          <div className="knowledge-sync-selection-footer">
              <small>{zh ? "所选文件将读取正文并加入上传队列。" : "Selected files will be downloaded and added to the upload queue."}</small>
            <button type="button" disabled={locked} onClick={() => void openVault(vaultId)}>{zh ? "刷新列表" : "Refresh list"}</button>
              <button className="knowledge-sync-primary" type="button" disabled={locked || !selected.size} onClick={() => void readSelected()}>{zh ? "上传所选文件 →" : "Upload selected files →"}</button>
          </div>
      </> : null}
    </>}
    {busy ? <p role="status">{zh ? "正在处理，请稍候…" : "Working…"}</p> : null}
    {error ? <p className="knowledge-form-error" role="alert">{error}</p> : null}
    {!loaded && !busy && error ? <button type="button" onClick={() => void run(async signal => {
      const result = await request({ action: "status" }, signal);
      setConnection(result.connection ?? null); setLoaded(true);
      if (result.connection) setVaults((await request({ action: "vaults", connectionId: result.connection.id }, signal)).vaults ?? []);
    })}>{zh ? "重试连接检查" : "Retry connection check"}</button> : null}
  </section>;
}
