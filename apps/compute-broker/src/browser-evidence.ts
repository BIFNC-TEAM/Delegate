/** Self-contained JavaScript evaluated in the page, with no live DOM mutation.
 * Preserve visible field boundaries before artifact sanitization. Markup labels
 * describe structure only; neither headings nor links establish authority.
 */
export const browserEvidenceExtractor = String.raw`(() => {
  let output = '';
  const append = value => { if (output.length < 8000) output += value; };
  const newline = () => { if (output && !output.endsWith('\n')) append('\n'); };
  const walk = (node, preserveWhitespace = false) => {
    if (output.length >= 8000) return;
    if (node.nodeType === 3) {
      const text = preserveWhitespace ? node.textContent.replace(/\r\n?/g, '\n') : node.textContent.replace(/\s+/g, ' ');
      // These are separate DOM text nodes, not an ambiguous concatenated
      // string. A boundary between decimal fields must survive innerText-like
      // rendering (e.g. a value followed by a percentage in adjacent spans).
      if (/\d\.\d+$/.test(output) && /^[+-]?\d+\.\d/.test(text)) append('\t');
      append(text);
      return;
    }
    if (node.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG)$/.test(node.tagName)) return;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return;
    if (node.tagName === 'BR') { newline(); return; }
    const table = node.tagName === 'TABLE';
    const row = node.tagName === 'TR';
    const cell = /^(TD|TH)$/.test(node.tagName);
    const heading = /^H[1-6]$/.test(node.tagName) || node.getAttribute('role') === 'heading' || node.tagName === 'CAPTION';
    const block = /^(block|list-item|flex|grid|table|table-row)$/.test(style.display);
    if (block || heading) newline();
    if (table) append('[table]\n');
    if (heading || node.tagName === 'A') {
      // A badge belongs to the heading/link that contains it, never the next
      // flattened line. Keep that visible DOM unit on one quoted line.
      newline();
      const value = (node.innerText || '').replace(/\s+/g, ' ').trim();
      const line = (heading ? '[heading] ' : '[link text] ') + JSON.stringify(value) + '\n';
      if (output.length + line.length <= 8000) append(line);
      else append('[truncated]\n');
      return;
    }
    for (const child of node.childNodes) walk(child, /pre|break-spaces/.test(style.whiteSpace || ''));
    if (cell) append('\t');
    if (block || heading || row) newline();
    if (table) append('[/table]\n');
  };
  if (document.body) walk(document.body);
  return output.replace(/ *\n */g, '\n').replace(/\t+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0,8000);
})()`;
