const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard, nativeTheme, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { resolveRuntime, inspectRuntime } = require('./runtime.cjs');

let window, backend, runtime, ai;
let dirty = false;
const artifacts = new Set();
const pdfJobs = new Map();
const pdfCache = new Map();
const printableWindows = new Map();
app.setName('DOConstruct');
nativeTheme.themeSource = 'dark';
const publish = (event) => {
  if (event.type === 'job' && event.job?.status === 'completed') {
    for (const key of ['htmlPath', 'pdfPath']) if (event.job[key]) artifacts.add(path.resolve(event.job[key]));
  }
  if (window && !window.isDestroyed()) window.webContents.send('doconstruct:event', event);
  if (window && !window.isDestroyed() && event.type === 'job') window.setProgressBar(['queued', 'running'].includes(event.job.status) ? 2 : -1);
};

async function projectAction(kind, args) {
  let root = args.path;
  if (!root) {
    const selected = await dialog.showOpenDialog(window, {
      title: kind === 'new' ? '选择新文档项目目录' : '打开文档文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    if (selected.canceled) return { canceled: true };
    root = selected.filePaths[0];
  }
  if (dirty) {
    const answer = await dialog.showMessageBox(window, { type: 'question', buttons: ['返回编辑', '放弃修改并继续'],
      defaultId: 0, cancelId: 0, message: '当前文档有未保存的修改。' });
    if (answer.response !== 1) return { canceled: true };
  }
  if (ai) await ai.dispatch('ai.cancel', {});
  const project = kind === 'new' ? await backend.createProject(root, args.options || {}) : await backend.openProject(root);
  dirty = false;
  artifacts.clear();
  pdfCache.clear();
  publish({ type: 'project', project });
  return project;
}

async function printPdf(htmlPath, destination, job) {
  await backend.registerOutput(destination);
  if (job.status === 'canceled') throw new Error('PDF 导出已取消。');
  const printWindow = new BrowserWindow({ show: false, width: 1200, height: 1000,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  printableWindows.set(job.id, printWindow);
  try {
    await printWindow.loadFile(htmlPath);
    const resources = await printWindow.webContents.executeJavaScript(`(async () => {
      await Promise.race([Promise.all([document.fonts.ready, ...Array.from(document.images, image =>
        image.complete ? Promise.resolve() : new Promise(resolve => {image.onload=resolve;image.onerror=resolve;})
      )]), new Promise((_, reject) => setTimeout(() => reject(new Error('字体或图片加载超时')), 20000))]);
      return Array.from(document.images).filter(image => !image.naturalWidth).map(image => image.getAttribute('src'));
    })()`);
    if (resources.length) throw new Error(`无法加载图片：${resources.slice(0, 8).join(', ')}`);
    const data = await printWindow.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: false });
    if (job.status === 'canceled') throw new Error('PDF 导出已取消。');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.doconstruct-${crypto.randomUUID()}.tmp`;
    await backend.registerOutput(temporary);
    await fs.writeFile(temporary, data, { flag: 'wx' });
    try { await fs.rename(temporary, destination); }
    catch (error) { await fs.rm(temporary, { force: true }); throw error; }
    return destination;
  } finally { printableWindows.delete(job.id); if (!printWindow.isDestroyed()) printWindow.destroy(); }
}

async function copyPdf(source, destination, job) {
  await backend.registerOutput(destination);
  if (job.status === 'canceled') throw new Error('PDF 导出已取消。');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.doconstruct-${crypto.randomUUID()}.tmp`;
  await backend.registerOutput(temporary);
  try {
    await fs.copyFile(source, temporary);
    if (job.status === 'canceled') throw new Error('PDF 导出已取消。');
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function startPdf(args, previewOnly = false) {
  const project = await backend.getProject();
  const sourceJob = args.jobId ? backend.getJob(args.jobId) : null;
  const htmlPath = sourceJob?.htmlPath || project?.latestPreview?.htmlPath;
  if (!htmlPath || !artifacts.has(path.resolve(htmlPath))) throw new Error('请先完成一次成功排版，再导出 PDF。');
  let destination = args.destination;
  if (!destination && !previewOnly) {
    const choice = await dialog.showSaveDialog(window, { title: '导出 PDF', defaultPath: `${project.title || 'document'}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (choice.canceled) return { canceled: true };
    destination = choice.filePath;
  }
  if (!previewOnly) {
    destination = path.resolve(destination);
    if (path.extname(destination).toLowerCase() !== '.pdf') throw new Error('PDF 文件必须使用 .pdf 扩展名。');
  }
  const id = `pdf-${crypto.randomUUID()}`;
  const job = { id, revision: sourceJob?.revision || project.revision, projectRoot: project.root, epoch: backend.epoch, previewOnly,
    status: 'running', stage: 'pdf', logs: [], diagnostics: [], stats: { renderedSections: 0, cachedSections: 0, elapsedMs: 0 }, htmlPath };
  pdfJobs.set(id, job); publish({ type: 'job', job });
  const started = Date.now();
  void (async () => {
    let cached = pdfCache.get(htmlPath);
    if (cached) { try { await fs.access(cached); } catch { pdfCache.delete(htmlPath); cached = null; } }
    if (!cached) {
      cached = path.join(app.getPath('userData'), 'cache', 'pdf', `${id}.pdf`);
      await printPdf(htmlPath, cached, job);
      if (job.status === 'canceled') throw new Error('PDF 导出已取消。');
      if (backend.epoch === job.epoch) pdfCache.set(htmlPath, cached);
    } else job.logs.push('复用当前排版的 PDF 成品，无需重新排版或列印。');
    if (!previewOnly) await copyPdf(cached, destination, job);
    return previewOnly ? cached : destination;
  })().then(async pdfPath => {
    if (job.status === 'canceled') return;
    const current = await backend.getProject();
    if (job.status === 'canceled') return;
    const active = current?.root === job.projectRoot && backend.epoch === job.epoch && current.revision === job.revision;
    Object.assign(job, { status: active ? 'completed' : 'superseded', stage: 'pdf', pdfPath });
    if (!active) job.diagnostics.push('PDF 已保存；当前文档已切换或修改，未将旧修订显示为新预览。');
  }).catch(error => {
    if (job.status !== 'canceled') Object.assign(job, { status: 'failed', diagnostics: [error.message] });
  }).finally(() => { job.stats.elapsedMs = Date.now() - started; publish({ type: 'job', job }); });
  return { jobId: id, revision: job.revision };
}

async function dispatch(method, args = {}) {
  if (typeof method !== 'string') throw new Error('操作名称必须为字符串。');
  if (method.startsWith('ai.')) return ai.dispatch(method, args);
  switch (method) {
    case 'clipboard.write': {
      if (typeof args.text !== 'string' || args.text.length > 8 * 1024 * 1024) throw new Error('复制内容必须是8 MiB以内的文本。');
      await clipboard.writeText(args.text); return { copied: true };
    }
    case 'project.open': return projectAction('open', args);
    case 'project.new': return projectAction('new', args);
    case 'project.get': return (await backend.getProject()) || { project: null };
    case 'project.refresh': return backend.refreshProject();
    case 'section.create': return backend.createSection(args);
    case 'file.list': return backend.listDirectory(args);
    case 'directory.create': return backend.createDirectory(args);
    case 'entry.rename': return backend.renameEntry(args);
    case 'entry.remove': return backend.removeEntry(args);
    case 'file.media': {
      const target = await backend.resolve(args.path);
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif' }[path.extname(target).toLowerCase()];
      if (!mime || !(await fs.stat(target)).isFile()) throw new Error('此文件不是支持的图片格式。');
      return { path: args.path, mime, url: pathToFileURL(target).href };
    }
    case 'file.read': return backend.readFile(args.path);
    case 'file.save': return backend.saveFile(args);
    case 'project.configure': return backend.saveConfig(args);
    case 'build.start': return backend.build(args);
    case 'build.inspect': return pdfJobs.get(args.id) || backend.getJob(args.id);
    case 'build.cancel': {
      const pdf = pdfJobs.get(args.id);
      if (!pdf) return backend.cancelJob(args.id);
      if (!['queued', 'running'].includes(pdf.status)) return { canceled: false };
      pdf.status = 'canceled'; printableWindows.get(args.id)?.destroy();
      publish({ type: 'job', job: pdf }); return { canceled: true };
    }
    case 'script.run': {
      const command = (await backend.getProject())?.config?.command;
      return backend.runCommand(args.argv ? args : command || {});
    }
    case 'pdf.export': return startPdf(args);
    case 'pdf.preview': return startPdf(args, true);
    case 'preview.url': {
      const project = await backend.getProject();
      const artifact = args.htmlPath || (args.jobId && (pdfJobs.get(args.jobId) || backend.getJob(args.jobId))?.htmlPath)
        || project?.latestPreview?.htmlPath;
      if (!artifact || !artifacts.has(path.resolve(artifact))) throw new Error('该预览产物不存在或不属于当前文档会话。');
      return { url: pathToFileURL(path.resolve(artifact)).href };
    }
    case 'artifact.open': {
      if (!args.path || !artifacts.has(path.resolve(args.path))) throw new Error('只能查看本会话生成的产物。');
      const message = await shell.openPath(args.path);
      if (message) throw new Error(`系统未能打开文件：${message}\n${args.path}`);
      return {};
    }
    case 'external.open': {
      const url = new URL(args.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new Error('只能在系統瀏覽器開啟 HTTP(S) 連結。');
      await shell.openExternal(url.href); return {};
    }
    case 'dependencies.inspect': return inspectRuntime(app, runtime, (await backend.getProject())?.config);
    case 'app.info': return { name: 'DOConstruct', version: app.getVersion(), platform: process.platform, packaged: app.isPackaged };
    case 'app.dirty': dirty = args.dirty === true; return {};
    default: throw new Error(`未知操作：${method}`);
  }
}

function menu() {
  const command = value => publish({ type: 'command', command: value });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '新建文档项目…', accelerator: 'CmdOrCtrl+N', click: () => command('new') },
      { label: '打开文档文件夹…', accelerator: 'CmdOrCtrl+O', click: () => command('open') },
      { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => command('save') },
      { type: 'separator' }, { label: '导出 PDF…', accelerator: 'CmdOrCtrl+Shift+E', click: () => command('pdf') },
      { role: 'quit', label: '退出' }
    ] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '构建', submenu: [{ label: '增量排版', accelerator: 'F5', click: () => command('build') },
      { label: '取消当前任务', accelerator: 'Escape', click: () => command('cancel') },
      { label: '检查依赖', click: () => command('dependencies') }] },
    { label: '视图', submenu: [{ role: 'resetZoom', label: '恢复缩放' }, { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' }] },
    { label: '帮助', submenu: [{ label: '关于 DOConstruct', click: () => dialog.showMessageBox(window,
      { title: 'DOConstruct', message: `DOConstruct ${app.getVersion()}`, detail: '内容 × 骨架 × 排版脚本\n独立文档编辑与增量构建工作台' }) }] }
  ]));
}

async function initialize() {
  runtime = resolveRuntime(app);
  const { DocumentBackend } = await import(pathToFileURL(path.join(__dirname, 'backend/index.mjs')).href);
  backend = new DocumentBackend({ pandocPath: runtime.pandoc.path, pythonPath: runtime.python.path,
    nodePath: process.execPath, onEvent: publish, cacheRoot: path.join(app.getPath('userData'), 'cache') });
  const { AiService } = require('./ai/service.cjs');
  ai = new AiService({ settingsPath: path.join(app.getPath('userData'), 'ai-settings.json'), safeStorage,
    backend, onEvent: publish, skillRoot: path.join(runtime.resources, 'skills') });
  window = new BrowserWindow({ width: 1560, height: 980, minWidth: 1060, minHeight: 700,
    title: 'DOConstruct', icon: path.join(runtime.resources, 'icon.png'), backgroundColor: '#181818', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, plugins: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (dirty && dialog.showMessageBoxSync(window, { type: 'question', buttons: ['返回编辑', '放弃修改并退出'],
      defaultId: 0, cancelId: 0, message: '文档有未保存的修改。' }) !== 1) event.preventDefault();
  });
  window.on('closed', () => {
    window = null;
    ai?.dispose();
    backend.dispose();
    for (const target of printableWindows.values()) if (!target.isDestroyed()) target.destroy();
    printableWindows.clear();
  });
  ipcMain.handle('doconstruct:invoke', async (event, method, args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      return { ok: false, error: { code: 'SENDER', message: '操作来源无效。' } };
    try { return { ok: true, ...await dispatch(method, args) }; }
    catch (error) { return { ok: false, error: { code: error.code || 'ERROR', message: error.message, details: error.details } }; }
  });
  menu();
  await window.loadFile(path.join(__dirname, '..', 'static/index.html'));
  window.show();
  const projectIndex = process.argv.indexOf('--project');
  if (projectIndex >= 0 && process.argv[projectIndex + 1]) {
    try { await projectAction('open', { path: process.argv[projectIndex + 1] }); }
    catch (error) { publish({ type: 'error', message: error.message }); }
  }
}

app.whenReady().then(initialize).catch(error => { dialog.showErrorBox('DOConstruct 启动失败', error.stack || error.message); app.exit(1); });
app.on('window-all-closed', () => app.quit());
