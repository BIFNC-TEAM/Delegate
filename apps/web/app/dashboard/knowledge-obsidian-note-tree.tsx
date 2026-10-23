"use client";
type Tree = { name: string; ids: string[]; children: Map<string, Tree>; note?: { id: string; path: string } };
export function buildObsidianNoteTree(notes: { id: string; path: string }[]) {
  const root: Tree = { name: "", ids: [], children: new Map() };
  for (const note of notes) {
    let node = root;
    for (const part of note.path.split("/")) {
      if (!node.children.has(part)) node.children.set(part, { name: part, ids: [], children: new Map() });
      node = node.children.get(part)!;
      node.ids.push(note.id);
    }
    node.note = note;
  }
  return root;
}
export function ObsidianNoteTree({ node, selected, select }: {
  node: Tree; selected: Set<string>; select: (ids: string[], checked: boolean) => void;
}) {
  return <ul className="knowledge-obsidian-tree">{[...node.children.values()].map(child => <li key={child.name}>
    <label>
      <input type="checkbox" checked={child.ids.every(id => selected.has(id))}
        ref={input => { if (input) input.indeterminate = child.ids.some(id => selected.has(id)) && !child.ids.every(id => selected.has(id)); }}
        onChange={e => select(child.ids, e.target.checked)} />
      <span title={child.note?.path}>{child.name}{child.note ? "" : "/"}</span>
    </label>
    {child.children.size ? <ObsidianNoteTree node={child} selected={selected} select={select} /> : null}
  </li>)}</ul>;
}
