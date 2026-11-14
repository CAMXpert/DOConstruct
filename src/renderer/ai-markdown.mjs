import MarkdownIt from 'markdown-it';

// AI text is untrusted: no raw HTML, images, local URLs or navigation from the workbench.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
markdown.validateLink = url => {
  try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !/[\u0000-\u0020\u007f]/.test(url); }
  catch { return false; }
};
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index], url = token.attrGet('href');
  token.attrSet('title', url);
  token.attrSet('aria-label', '連結：' + url);
  token.attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml('[圖片：' + tokens[index].content + ']');

export function renderAiMarkdown(text) { return markdown.render(String(text || '')); }
