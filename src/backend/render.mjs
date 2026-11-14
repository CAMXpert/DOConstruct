import { createHash } from 'node:crypto';
import { runProcess } from './process.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function globalReason(config, sections) {
  const text = sections.map(s => s.markdown).join('\n\n');
  if (/\[\^[^\]]+\]/.test(text)) return 'Footnotes need full-document resolution.';
  if (/\]\s*\[[^\]]*\]|^\s{0,3}\[[^\]]+\]:/m.test(text)) return 'Reference-style links need full-document resolution.';
  if (/\]\(\s*#|href\s*=\s*["']#/i.test(text)) return 'Internal anchors may cross chapter boundaries.';
  if (/(?:^|\[|\s)@[-\w:]+/m.test(text)) return 'Citations need full-document resolution.';
  if (/\\(?:newcommand|renewcommand|def)\b/.test(text)) return 'Math macro definitions may be shared across chapters.';
  return null;
}

export class MarkdownRenderer {
  constructor(pandocPath) { this.pandocPath = pandocPath; this.cache = new Map(); this.version = null; }
  async initialize(signal) {
    if (!this.version) this.version = (await runProcess(this.pandocPath, ['--version'], { signal })).stdout.split('\n')[0];
  }
  async render(config, sections, { signal, cwd, onStage, onLog }) {
    await this.initialize(signal);
    const reason = globalReason(config, sections);
    const args = ['--from=markdown+tex_math_single_backslash', '--to=html5', '--math-method=mathml'];
    const stats = { renderedSections: 0, cachedSections: 0, mode: reason ? 'global' : 'sections', reason };
    const units = reason ? [{ id: 'document', title: config.title, markdown: sections.map(s => s.markdown).join('\n\n') }] : sections;
    const result = [];
    for (const unit of units) {
      if (signal.aborted) throw Object.assign(new Error('Task canceled.'), { code: 'CANCELED' });
      const flags = reason ? args : [...args, `--id-prefix=${unit.id}-`];
      const key = digest(JSON.stringify([this.version, flags, unit.markdown]));
      let html = this.cache.get(key);
      if (html === undefined) {
        onStage(`markdown:${unit.id}`);
        const rendered = await runProcess(this.pandocPath, flags, { cwd, input: unit.markdown, signal, onLog: (kind, text) => { if (kind === 'stderr') onLog(kind, text); } });
        html = rendered.stdout; this.cache.set(key, html); stats.renderedSections += reason ? sections.length : 1;
        if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value);
      } else stats.cachedSections += reason ? sections.length : 1;
      result.push({ id: unit.id, title: unit.title, html });
    }
    return { sections: result, stats };
  }
}

export function documentCss(style) {
  const width = { A4: 210, A5: 148, A3: 297, Letter: 215.9, Legal: 215.9 }[style.pageSize];
  return `:root{--body-font:${JSON.stringify(style.fontFamily)};--body-size:${style.fontSizePt}pt;--body-leading:${style.lineHeight};}
@page{size:${style.pageSize};margin:${style.marginTopMm}mm ${style.marginRightMm}mm ${style.marginBottomMm}mm ${style.marginLeftMm}mm;}
body{font-family:var(--body-font),serif;font-size:var(--body-size);line-height:var(--body-leading);}
img,svg{max-width:100%;height:auto} table{border-collapse:collapse;max-width:100%} th,td{border:1px solid #c8cdd3;padding:.35em .6em} pre{white-space:pre-wrap} h1,h2,h3{break-after:avoid} figure,math[display=block]{break-inside:avoid}
@media screen{body{box-sizing:border-box;max-width:${width}mm;padding:${style.marginTopMm}mm ${style.marginRightMm}mm ${style.marginBottomMm}mm ${style.marginLeftMm}mm;margin:auto;background:white}html{background:#e7ebef}}`;
}

export function defaultDocument(context) {
  return `<!doctype html><html lang="${escapeHtml(context.language || 'zh-CN')}"><head><meta charset="utf-8"><base href="${escapeHtml(context.baseUrl)}"><title>${escapeHtml(context.title)}</title><style>${context.css}</style></head><body>${context.sections.map(s => `<section data-section-id="${escapeHtml(s.id)}">${s.html}</section>`).join('\n')}</body></html>`;
}
