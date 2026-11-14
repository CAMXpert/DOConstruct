const types = {
  directory: { label: '文件夾', color: '#d4b45c', shape: '<path d="M2 5h7l2 2h11v14H2z"/>', mark: '' },
  markdown: { label: 'Markdown 文件', color: '#78b5df', mark: 'M' },
  image: { label: '圖片', color: '#a993da', shape: '<rect x="2" y="3" width="20" height="18" rx="2"/><circle cx="8" cy="9" r="2"/><path d="m3 19 6-6 4 4 4-6 5 8"/>', mark: '' },
  python: { label: 'Python 腳本', color: '#e4c46e', mark: 'Py' },
  javascript: { label: 'JavaScript 腳本', color: '#e4d26b', mark: 'JS' },
  css: { label: 'CSS 樣式', color: '#79b7df', mark: '#' },
  json: { label: 'JSON 配置', color: '#c7b47a', mark: '{}' },
  pdf: { label: 'PDF 文件', color: '#e58b87', mark: 'P' },
  file: { label: '一般文件', color: '#adb4bc', mark: '·' }
};
export function fileIcon(entry) {
  const extension = entry.name.split('.').at(-1).toLowerCase();
  const kind = entry.type === 'directory' ? 'directory' : ({ md:'markdown',markdown:'markdown',png:'image',jpg:'image',jpeg:'image',gif:'image',webp:'image',svg:'image',bmp:'image',ico:'image',avif:'image',py:'python',js:'javascript',mjs:'javascript',cjs:'javascript',css:'css',json:'json',pdf:'pdf' }[extension] || 'file');
  const type = types[kind], svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'file-icon file-icon-' + kind); svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', type.label); svg.style.color = type.color;
  const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = type.label;
  svg.append(title);
  // All markup below is fixed local artwork; entry names never enter SVG markup.
  svg.insertAdjacentHTML('beforeend', type.shape || '<path d="M5 2h10l5 5v15H5z"/><path d="M15 2v6h5"/>');
  if (type.mark) { const text = document.createElementNS(svg.namespaceURI, 'text'); text.setAttribute('x', '12.5'); text.setAttribute('y', '17'); text.textContent = type.mark; svg.append(text); }
  return svg;
}
