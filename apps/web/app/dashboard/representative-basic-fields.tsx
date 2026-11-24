"use client";
import { WorkbenchPanelHeading } from "./representative-workbench";
import Link from "next/link";
import { RepresentativeAvatarEditor } from "./representative-avatar-editor";

export type BasicFields = {
  name: string;
  tagline: string;
  tone: string;
  avatarUrl?: string | null;
  languages: string[];
  ownerName: string;
  knowledgePack: { identitySummary: string };
};
export function RepresentativeBasicFields({
  draft,
  onChange,
  onAvatarBusy,
}: {
  draft: BasicFields;
  onChange: (
    patch: Partial<Omit<BasicFields, "knowledgePack">> & {
      identitySummary?: string;
    },
  ) => void;
  onAvatarBusy: (busy: boolean) => void;
}) {
  return (
    <div className="d-grid2">
      <section className="d-panel">
        <header className="d-panel-head">
          <WorkbenchPanelHeading
            icon="user"
            title="创建者信息"
            description="让对外代理了解它代表的人。"
          />
        </header>
        <div className="d-panel-body">
          <div className="d-profile-field">
            <span className="d-label">创建者昵称</span>
            <div>
              <strong>{draft.ownerName}</strong>
              <Link
                className="d-button d-ghost"
                href="/dashboard?view=settings&settingsSection=profile&lang=zh"
              >
                修改
              </Link>
            </div>
          </div>
          <label className="d-field">
            <span className="d-label">创建者身份简介</span>
            <textarea
              rows={7}
              maxLength={1200}
              value={draft.knowledgePack.identitySummary}
              onChange={(e) => onChange({ identitySummary: e.target.value })}
              required
            />
            <span className="d-help">介绍你的身份背景与工作方向。</span>
          </label>
        </div>
      </section>
      <section className="d-panel">
        <header className="d-panel-head">
          <WorkbenchPanelHeading
            icon="bot"
            title="对外代理信息"
            description="向访客说明它能提供什么帮助。"
          />
        </header>
        <div className="d-panel-body">
          <RepresentativeAvatarEditor
            value={draft.avatarUrl || ""}
            name={draft.name}
            onChange={(avatarUrl) => onChange({ avatarUrl })}
            onBusyChange={onAvatarBusy}
          />
          <label className="d-field">
            <span className="d-label">对外代理名称</span>
            <input
              required
              maxLength={60}
              value={draft.name}
              onChange={(e) => onChange({ name: e.target.value })}
            />
          </label>
          <label className="d-field">
            <span className="d-label">对外代理简介</span>
            <textarea
              required
              maxLength={500}
              rows={3}
              value={draft.tagline}
              onChange={(e) => onChange({ tagline: e.target.value })}
            />
          </label>
          <label className="d-field">
            <span className="d-label">对外代理表达风格</span>
            <textarea
              required
              rows={2}
              maxLength={600}
              value={draft.tone}
              onChange={(e) => onChange({ tone: e.target.value })}
            />
          </label>
          <label className="d-field">
            <span className="d-label">支持语言</span>
            <select
              value={draft.languages.join(",")}
              onChange={(e) =>
                onChange({ languages: e.target.value.split(",") })
              }
            >
              <option value="zh,en">中文、英文</option>
              <option value="zh">中文</option>
              <option value="en">英文</option>
            </select>
          </label>
        </div>
      </section>
    </div>
  );
}
