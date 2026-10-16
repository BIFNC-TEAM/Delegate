"use client";

import { useEffect, useRef, useState } from "react";
import {
  isObsidianNotePath, MAX_OBSIDIAN_NOTES, MAX_OBSIDIAN_SELECTION_BYTES,
  nextObsidianFileName, parseObsidianNote, prepareObsidianNotes,
  type KnowledgeName, type ObsidianImportMetadata, type PreparedObsidianNote,
} from "@delegate/web-data/knowledge-obsidian";

export type ObsidianUpload = { file: File; metadata: ObsidianImportMetadata; previewText: string };
type NoteFile = { path: string; file: File };
export function KnowledgeObsidianImport({ activeSlug, zh, disabled, onPrepared, onBusyChange }: {
  activeSlug: string; zh: boolean; disabled: boolean;
  onPrepared: (items: ObsidianUpload[], removeSelection?: (path: string) => void) => void; onBusyChange: (busy: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const preparationRef = useRef<AbortController | null>(null);
  useEffect(() => () => preparationRef.current?.abort(), []);
  const [files, setFiles] = useState<NoteFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PreparedObsidianNote[]>([]);
  const [ignoredCount, setIgnoredCount] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const renames = preview.filter((note) => note.fileName !== note.path.split("/").pop());
  const requestedPaths = [...new Set(preview.flatMap((note) => note.requestedPaths))];
  const locked = disabled || busy;

  function displayMessage(message: string) {
    let result = message.replace("引用重名，请明确路径", "引用重名，请区分笔记名称后重新选择");
    for (const { path, file } of files) result = result.replaceAll(path, file.name);
    return result;
  }

  function updateSelection(noteFiles: NoteFile[], selection: Set<string>) {
    setFiles(noteFiles);
    setSelected(selection);
    void prepare(noteFiles, selection);
  }

  function selectPaths(paths: string[], checked: boolean) {
    const next = new Set(selected);
    for (const path of paths) { if (checked) next.add(path); else next.delete(path); }
    updateSelection(files, next);
  }

  function chooseFiles(list: File[]) {
    // File pickers expose names, not original directories. Give each file a unique
    // import-local path so same-name files stay separate and references stay ambiguous.
    if (!list.length) return;
    const notes = list.filter((file) => isObsidianNotePath(file.name))
      .map((file) => ({ path: `selected/${crypto.randomUUID()}/${file.name}`, file }));
    setIgnoredCount((current) => current + list.length - notes.length);
    setErrors(notes.length ? [] : [zh ? "请选择 .md 或 .markdown 笔记文件。" : "Choose .md or .markdown note files."]);
    if (notes.length) updateSelection([...files, ...notes], new Set([...selected, ...notes.map(({ path }) => path)]));
  }

  async function prepare(noteFiles: NoteFile[], selection: Set<string>) {
    preparationRef.current?.abort();
    const controller = new AbortController();
    preparationRef.current = controller;
    // Keep the last complete snapshot visible while preparing its replacement.
    // The parent disables uploads until the new selection has been prepared.
    setBusy(true); onBusyChange(true); setErrors([]);
    try {
      const chosen = noteFiles.filter(({ path }) => selection.has(path));
      if (!chosen.length) { setPreview([]); onPrepared([]); return; }
      if (chosen.length > MAX_OBSIDIAN_NOTES) throw new Error(zh ? `每次最多选择 ${MAX_OBSIDIAN_NOTES} 篇笔记。` : `Select up to ${MAX_OBSIDIAN_NOTES} notes per import.`);
      if (chosen.reduce((sum, { file }) => sum + file.size, 0) > MAX_OBSIDIAN_SELECTION_BYTES) throw new Error(zh ? "所选笔记正文合计不能超过 40 MB，请分批选择。" : "Selected notes exceed 40 MB. Choose a smaller batch.");
      const notes = [];
      for (const { path, file } of chosen) notes.push(parseObsidianNote(path, await file.text()));
      controller.signal.throwIfAborted();
      const prepared = prepareObsidianNotes(notes, noteFiles.map(({ path }) => path));
      const response = await fetch("/api/dashboard/knowledge-assets?namesOnly=true", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), headers: { "X-Delegate-Representative": activeSlug } });
      const payload = await response.json() as { names: KnowledgeName[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Unable to load knowledge filenames.");
      controller.signal.throwIfAborted();
      const names = [...payload.names];
      for (const note of prepared) {
        note.fileName = nextObsidianFileName(note.fileName, names);
        names.push({ originalFileName: note.fileName, title: note.fileName.replace(/\.[^.]+$/, "") });
      }
      setPreview(prepared);
      onPrepared(prepared.map((note) => ({ file: new File([note.text], note.fileName, { type: "text/markdown" }), metadata: note.metadata, previewText: note.text })), (path) => {
        const next = new Set(selection);
        next.delete(path);
        updateSelection(noteFiles, next);
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setPreview([]); onPrepared([]);
        setErrors([error instanceof Error && error.name === "TimeoutError"
        ? (zh ? "准备超时，请重试。" : "Preparation timed out. Please retry.")
        : error instanceof Error ? error.message : (zh ? "笔记准备失败。" : "Unable to prepare notes.")]);
      }
    } finally {
      if (preparationRef.current === controller && !controller.signal.aborted) { setBusy(false); onBusyChange(false); }
    }
  }

  return <section className="knowledge-obsidian-import" aria-busy={busy} aria-label={zh ? "Obsidian 本地导入" : "Obsidian local import"}>
    <div className="knowledge-conflict-policy"><div><span>Obsidian</span><small>{zh ? "选择本地 Markdown 笔记，引用的笔记需一并选择" : "Select local Markdown notes, including any referenced notes."}</small></div>
      <button type="button" disabled={locked} onClick={() => inputRef.current?.click()}>{zh ? (files.length ? "继续添加文件" : "选择笔记文件") : (files.length ? "Add more files" : "Choose note files")}</button>
      <input ref={inputRef} hidden type="file" multiple accept=".md,.markdown" onChange={(event) => { chooseFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    </div>
    {files.length ? <fieldset disabled={locked} className="knowledge-obsidian-selection">
      <legend>{zh ? "选择要导入的笔记" : "Choose notes to import"}</legend>
      <div className="knowledge-obsidian-selection-heading"><label><input type="checkbox" checked={selected.size === files.length} onChange={(event) => selectPaths(files.map(({ path }) => path), event.target.checked)} />{zh ? "全选" : "Select all"}</label><small>{zh ? `已选 ${selected.size} / ${files.length} 篇` : `${selected.size} / ${files.length} selected`}</small></div>
      <div className="knowledge-obsidian-tree-scroll"><ul className="knowledge-obsidian-tree">{files.map(({ path, file }) => <li key={path}>
        <label><input type="checkbox" aria-label={`${zh ? "选择" : "Select"} ${file.name}`} checked={selected.has(path)} onChange={(event) => selectPaths([path], event.target.checked)} /><span>{file.name}</span></label>
      </li>)}</ul></div>
      {ignoredCount ? <p>{zh ? `已排除 ${ignoredCount} 个附件、配置或其他非笔记文件。` : `${ignoredCount} attachments, settings, or other non-note files excluded.`}</p> : null}
    </fieldset> : null}
    {errors.length ? <div className="knowledge-form-error" role="alert">{errors.map(displayMessage).join("\n")}<button type="button" disabled={locked || !selected.size} onClick={() => void prepare(files, selected)}>{zh ? "重新准备" : "Retry preparation"}</button></div> : null}
    {renames.length || requestedPaths.length ? <div className="knowledge-obsidian-preview">
      {renames.length ? <div className="knowledge-obsidian-notice" role="status"><p>{zh ? "下列上传文件与已有文件或本批其他文件重名，已自动更改名称：" : "These filenames have been renamed to avoid duplicates:"}</p><ul>{renames.map((note) => <li key={note.path}>{note.path.split("/").pop()} → <strong>{note.fileName}</strong></li>)}</ul></div> : null}
      {requestedPaths.length ? <div className="knowledge-obsidian-notice"><p>{zh ? "以下引用笔记尚未获准导入。可以逐项允许，待上传内容会自动更新；未允许的内容不会上传。" : "These referenced notes are not selected. Allow individual notes to update the upload automatically; unselected content is never uploaded."}</p><ul>{requestedPaths.map((path) => <li key={path}><span>{path.split("/").pop()}</span><button type="button" disabled={locked} onClick={() => selectPaths([path], true)}>{zh ? "允许并勾选" : "Allow and select"}</button></li>)}</ul></div> : null}

    </div> : null}
  </section>;
}
