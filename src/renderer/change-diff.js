import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, GutterMarker, drawSelection, gutter, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { Change, MergeView } from '@codemirror/merge';
import { diffLines } from 'diff';

// CodeMirror normalizes document line endings before parsing and rendering.
const documentText = value => String(value ?? '').replace(/\r\n?/g, '\n');

export function buildLineDiff(before, after, config = { timeout: 80 }) {
  before = documentText(before); after = documentText(after);
  const parts = diffLines(before, after, config);
  if (!parts) return null;
  const changes = [], removed = [], added = [];
  let fromA = 0, fromB = 0, pending = null;
  const flush = () => {
    if (pending) changes.push(new Change(pending.fromA, fromA, pending.fromB, fromB));
    pending = null;
  };
  for (const part of parts) {
    if (!part.added && !part.removed) {
      flush(); fromA += part.value.length; fromB += part.value.length;
    } else {
      pending ??= { fromA, fromB };
      if (part.removed) { removed.push({ from: fromA, to: fromA + part.value.length }); fromA += part.value.length; }
      if (part.added) { added.push({ from: fromB, to: fromB + part.value.length }); fromB += part.value.length; }
    }
  }
  flush();
  return { changes, removed, added };
}

class ChangeMarker extends GutterMarker {
  constructor(sign) { super(); this.sign = sign; this.elementClass = sign === '+' ? 'change-diff-added-marker' : 'change-diff-removed-marker'; }
  toDOM(view) { const span = view.dom.ownerDocument.createElement('span'); span.textContent = this.sign; return span; }
}
const addedMarker = new ChangeMarker('+'), removedMarker = new ChangeMarker('-');

function changedLines(doc, ranges, side) {
  const lines = new RangeSetBuilder(), markers = new RangeSetBuilder();
  const decoration = Decoration.line({ class: side === 'before' ? 'change-diff-removed' : 'change-diff-added' });
  const marker = side === 'before' ? removedMarker : addedMarker;
  for (const range of ranges) {
    let line = doc.lineAt(range.from);
    while (line.from < range.to) {
      lines.add(line.from, line.from, decoration); markers.add(line.from, line.from, marker);
      if (line.to >= doc.length) break;
      line = doc.line(line.number + 1);
    }
  }
  const decorations = lines.finish(), gutterMarkers = markers.finish();
  return [EditorView.decorations.of(decorations), gutter({ class: 'change-diff-gutter', markers: () => gutterMarkers })];
}

const diffTheme = EditorView.theme({
  '&': { minWidth: '0', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'Consolas, "Cascadia Code", monospace', lineHeight: '1.6' },
  '.cm-content': { padding: '8px 0' },
  '.cm-line': { padding: '0 10px' },
  '.cm-changedLine': { backgroundColor: 'transparent' },
  '&.cm-merge-a .cm-changedLine': { backgroundColor: 'transparent' },
  '&.cm-merge-b .cm-changedLine': { backgroundColor: 'transparent' },
  '.change-diff-removed, &.cm-merge-a .change-diff-removed': { backgroundColor: 'rgba(248,81,73,.18)' },
  '.change-diff-added, &.cm-merge-b .change-diff-added': { backgroundColor: 'rgba(46,160,67,.20)' },
  '.cm-insertedLine, .cm-deletedLine, .cm-changedText': { textDecoration: 'none', background: 'none' },
  '.change-diff-gutter': { minWidth: '18px', textAlign: 'center' },
  '.change-diff-gutter .cm-gutterElement': { padding: '0 3px' },
  '.change-diff-removed-marker': { color: '#f48771', backgroundColor: 'rgba(248,81,73,.18)' },
  '.change-diff-added-marker': { color: '#89d185', backgroundColor: 'rgba(46,160,67,.20)' },
  '.cm-collapsedLines': { fontFamily: 'inherit', fontSize: '12px' }
});

const context = { margin: 3, minSize: 4 };
const diffCache = new Map();

function cachedLineDiff(options, before, after) {
  const key = JSON.stringify([options.id, options.path, options.afterVersion]);
  const cached = diffCache.get(key);
  if (cached && cached.before === before && cached.after === after) {
    diffCache.delete(key); diffCache.set(key, cached); return cached.difference;
  }
  const difference = buildLineDiff(before, after);
  diffCache.delete(key); diffCache.set(key, { before, after, difference });
  if (diffCache.size > 24) diffCache.delete(diffCache.keys().next().value);
  return difference;
}

/** Read-only snapshots. The caller injects the normal editor's theme and language extensions. */
export function createChangeDiff(host, options) {
  const document = host.ownerDocument;
  const root = document.createElement('div'); root.className = 'change-diff';
  Object.assign(root.style, { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0', minWidth: '0', overflow: 'hidden' });
  const headings = document.createElement('div'); headings.className = 'change-diff-headings';
  Object.assign(headings.style, { display: 'grid', gridTemplateColumns: '1fr 1fr', flex: 'none', borderBottom: '1px solid #333' });
  const beforeTitle = document.createElement('div'), afterTitle = document.createElement('div');
  for (const title of [beforeTitle, afterTitle]) Object.assign(title.style, { padding: '8px 12px', fontSize: '12px', color: '#bbb' });
  beforeTitle.style.borderRight = '1px solid #333';
  headings.append(beforeTitle, afterTitle);
  const warning = document.createElement('div'); warning.className = 'change-diff-warning'; warning.setAttribute('role', 'status');
  Object.assign(warning.style, { padding: '8px 12px', color: '#d7ba7d', fontSize: '12px', flex: 'none' });
  const body = document.createElement('div'); body.className = 'change-diff-body';
  Object.assign(body.style, { flex: '1', minHeight: '0', minWidth: '0', overflow: 'hidden' });
  root.append(headings, warning, body); host.append(root);
  let current = null, merge = null, editors = [], destroyed = false;

  function release() { if (merge) merge.destroy(); else for (const editor of editors) editor.destroy(); merge = null; editors = []; body.replaceChildren(); }
  function update(next) {
    if (destroyed) return;
    const value = { ...current, ...next };
    const before = documentText(value.before), after = documentText(value.after);
    const mode = value.mode === 'full' ? 'full' : 'diff';
    if (current && current.path === value.path && documentText(current.before) === before && documentText(current.after) === after && (current.before == null) === (value.before == null) && (current.after == null) === (value.after == null)) {
      if (merge && mode !== current.mode) merge.reconfigure({ collapseUnchanged: mode === 'diff' ? context : undefined });
      current = { ...value, mode }; root.dataset.mode = mode; return;
    }
    release(); body.style.display = 'block'; body.style.gridTemplateColumns = ''; current = { ...value, mode }; root.dataset.mode = mode;
    beforeTitle.textContent = value.before == null ? '修改前 · 文件不存在' : '修改前';
    afterTitle.textContent = value.after == null ? 'AI 寫入後 · 文件已刪除' : 'AI 寫入後';
    const difference = cachedLineDiff(value, before, after);
    warning.hidden = !!difference;
    warning.textContent = difference ? '' : '文件差異較大，已切換為完整內容檢視；本次未標記差異。';
    root.dataset.diffState = difference ? 'exact' : 'full-fallback';
    function editorConfig(text, side, ranges) {
      const doc = EditorState.create({ doc: text }).doc;
      return { doc, extensions: [value.extensions || [], diffTheme, lineNumbers(), drawSelection(), highlightSpecialChars(), EditorView.lineWrapping,
        EditorState.readOnly.of(true), EditorView.editable.of(false),
        EditorState.transactionFilter.of(transaction => transaction.docChanged ? [] : transaction),
        EditorView.editorAttributes.of({ class: `change-diff-${side}` }),
        EditorView.contentAttributes.of({ 'aria-label': `${side === 'before' ? '修改前' : 'AI 寫入後'}：${value.path || '文件'}`, tabindex: '0' }),
        keymap.of([...defaultKeymap, ...searchKeymap]), changedLines(doc, ranges, side)] };
    }
    if (difference) {
      // Native chunks may widen across tiny unchanged gaps. Only exact line ranges receive color and +/- markers.
      merge = new MergeView({ parent: body, a: editorConfig(before, 'before', difference.removed), b: editorConfig(after, 'after', difference.added),
        highlightChanges: false, gutter: false, diffConfig: { override: () => difference.changes.map(change => new Change(change.fromA, change.toA, change.fromB, change.toB)) },
        collapseUnchanged: mode === 'diff' ? context : undefined });
      Object.assign(merge.dom.style, { height: '100%', overflow: 'auto' });
      merge.a.dom.parentElement.style.borderRight = '1px solid #333';
      editors = [merge.a, merge.b];
    } else {
      Object.assign(body.style, { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' });
      for (const [text, side] of [[before, 'before'], [after, 'after']]) {
        const pane = document.createElement('div'); Object.assign(pane.style, { overflow: 'auto', minWidth: '0' }); body.append(pane);
        editors.push(new EditorView({ parent: pane, ...editorConfig(text, side, []) }));
      }
    }
  }
  update(options);
  return { update, destroy() { if (destroyed) return; destroyed = true; release(); root.remove(); } };
}
