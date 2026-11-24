"use client";
import { WorkbenchIcon } from "./representative-workbench";
import { useRef, useState } from "react";

export function RepresentativeAvatar({
  url,
  name,
  className = "d-avatar",
}: {
  url?: string | null | undefined;
  name: string;
  className?: string;
}) {
  return url ? (
    <img className={className} src={url} alt={`${name}头像`} />
  ) : (
    <span className={className} aria-label="默认文字头像">
      {Array.from(name.trim())[0] || "代"}
    </span>
  );
}
export function RepresentativeAvatarEditor({
  value,
  name,
  onChange,
  onBusyChange,
}: {
  value: string;
  name: string;
  onChange: (url: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  async function upload(file?: File) {
    if (!file) return;
    if (
      file.size > 5 * 1024 * 1024 ||
      !["image/jpeg", "image/png", "image/webp"].includes(file.type)
    ) {
      setError("请选择 5 MB 以内的 JPG、PNG 或 WebP 图片。");
      return;
    }
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const response = await fetch("/api/dashboard/representatives/avatar", {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const data = await response.json();
      if (!response.ok || typeof data.url !== "string")
        throw new Error(data.error || "头像上传失败，请重试。");
      onChange(data.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "头像上传失败，请重试。");
    } finally {
      setBusy(false);
      onBusyChange(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <div className="d-avatar-editor">
      <div className="d-avatar-editor-row">
        <RepresentativeAvatar
          url={value}
          name={name}
          className="d-avatar-upload-preview"
        />
        <div className="d-avatar-editor-controls">
          <div className="d-avatar-label">
            对外代理头像 <span>选填</span>
          </div>
          <div className="d-row">
            <button
              type="button"
              className="d-button"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <WorkbenchIcon name="upload" />
              {busy ? "正在处理…" : value ? "更换头像" : "上传头像"}
            </button>
            {value ? (
              <button
                className="d-button"
                type="button"
                disabled={busy}
                onClick={() => onChange("")}
              >
                移除
              </button>
            ) : null}
          </div>
          <p className="d-help">JPG、PNG、WebP · 最大 5 MB</p>
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={(e) => void upload(e.target.files?.[0])}
          />
          {error ? (
            <p className="d-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
