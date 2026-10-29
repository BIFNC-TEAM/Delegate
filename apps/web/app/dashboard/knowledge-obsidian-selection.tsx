"use client";

import type { ReactNode } from "react";

export function KnowledgeObsidianSelection({ zh, disabled, selectedCount, totalCount, onSelectAll, children }: {
  zh: boolean; disabled: boolean; selectedCount: number; totalCount: number;
  onSelectAll: (checked: boolean) => void; children: ReactNode;
}) {
  return <fieldset disabled={disabled} className="knowledge-obsidian-selection">
    <legend>{zh ? "选择要导入的笔记" : "Choose notes to import"}</legend>
    <div className="knowledge-obsidian-selection-heading">
      <label><input type="checkbox" checked={totalCount > 0 && selectedCount === totalCount}
        ref={input => { if (input) input.indeterminate = selectedCount > 0 && selectedCount < totalCount; }}
        onChange={event => onSelectAll(event.target.checked)} />{zh ? "全选" : "Select all"}</label>
      <small>{zh ? `已选 ${selectedCount} / ${totalCount} 篇` : `${selectedCount} / ${totalCount} selected`}</small>
    </div>
    <div className="knowledge-obsidian-tree-scroll">{children}</div>
  </fieldset>;
}
