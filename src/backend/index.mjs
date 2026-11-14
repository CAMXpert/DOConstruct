import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BackendError, runProcess } from './process.mjs';
import { MarkdownRenderer, digest, documentCss, defaultDocument } from './render.mjs';

const TEMPLATE = fileURLToPath(new URL('../../templates/default/', import.meta.url));
const DEFAULT_STYLE = { fontFamily: 'Times New Roman', fontSizePt: 12, lineHeight: 1.5,
  pageSize: 'A4', marginTopMm: 20, marginRightMm: 20, marginBottomMm: 20, marginLeftMm: 20 };
const EDITABLE = new Set(['.md', '.txt', '.json', '.css', '.py', '.js', '.mjs', '.ps1', '.lua', '.bib', '.csl', '.yaml', '.yml']);
const terminal = new Set(['completed', 'failed', 'canceled', 'superseded']);
const INTERNAL = new Set(['.git', 'node_modules', '.doconstruct']);
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.pdf', '.zip', '.7z', '.rar', '.docx', '.xlsx', '.pptx', '.exe', '.dll', '.woff', '.woff2', '.ttf']);
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const language = name => ({ '.md': 'markdown', '.py': 'python', '.js': 'javascript', '.mjs': 'javascript', '.json': 'json', '.css': 'css', '.ps1': 'powershell', '.lua': 'lua', '.yaml': 'yaml', '.yml': 'yaml' }[path.extname(name).toLowerCase()] || 'text');
const error = (code, message, details) => new BackendError(code, message, details);
const copy = value => JSON.parse(JSON.stringify(value));
const fileKey = relative => process.platform === 'win32' ? relative.toLowerCase() : relative;
const SECTION_PRESETS = {
  paper: ['摘要', '引言', '相关研究', '方法', '实验与结果', '讨论', '结论', '参考文献'],
  patent: ['发明名称', '技术领域', '背景技术', '发明内容', '附图说明', '具体实施方式', '权利要求书', '说明书摘要']
};

function relativePath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || path.isAbsolute(value) || /^[a-z]:/i.test(value)) throw error('PATH', 'Use a relative project file path.', { path: value });
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').includes('..')) throw error('PATH', 'A project path cannot leave the project folder.', { path: value });
  return path.posix.normalize(normalized);
}

function validateConfig(input) {
  if (!input || input.version !== 1 || typeof input.title !== 'string' || !Array.isArray(input.sections)) throw error('CONFIG', 'Expected version 1, a title and an ordered sections array.');
  const ids = new Set(); const paths = new Set();
  const sections = input.sections.map((s, i) => {
    const id = String(s.id || `section-${i + 1}`);
    if (!/^[\w-]+$/.test(id) || ids.has(id)) throw error('CONFIG', `Section ID is invalid or duplicated: ${id}`);
    ids.add(id); const p = relativePath(s.path);
    if (paths.has(p)) throw error('CONFIG', `Section source is repeated: ${p}`);
    paths.add(p);
    return { id, title: String(s.title || id), path: p, enabled: s.enabled !== false };
  });
  const style = { ...DEFAULT_STYLE, ...input.style };
  if (typeof style.fontFamily !== 'string' || !style.fontFamily.trim()) throw error('CONFIG', 'A body font family is required.');
  for (const key of ['fontSizePt', 'lineHeight', 'marginTopMm', 'marginRightMm', 'marginBottomMm', 'marginLeftMm']) {
    if (!Number.isFinite(style[key]) || style[key] < 0 || (['fontSizePt', 'lineHeight'].includes(key) && style[key] === 0)) throw error('CONFIG', `Invalid style value: ${key}`);
  }
  if (!['A4', 'A5', 'A3', 'Letter', 'Legal'].includes(style.pageSize)) throw error('CONFIG', 'Unsupported page size. Use A4, A5, A3, Letter or Legal.');
  const config = { version: 1, title: input.title, sections, style,
    layoutScript: input.layoutScript ? relativePath(input.layoutScript) : '',
    stylesheet: input.stylesheet ? relativePath(input.stylesheet) : '' };
  if (input.command) {
    if (!Array.isArray(input.command.argv) || !input.command.argv.length || input.command.argv.some(x => typeof x !== 'string')) throw error('CONFIG', 'Command argv must be a nonempty string array.');
    config.command = { argv: [...input.command.argv], outputs: (input.command.outputs || []).map(relativePath) };
  }
  if (input.pythonModules) {
    if (!Array.isArray(input.pythonModules) || input.pythonModules.some(x => typeof x !== 'string' || !/^[\w.]+$/.test(x))) throw error('CONFIG', 'pythonModules must contain module names.');
    config.pythonModules = [...input.pythonModules];
  }
  return config;
}

export class DocumentBackend {
  constructor({ pandocPath, pythonPath, nodePath = process.execPath, onEvent = () => {}, cacheRoot } = {}) {
    this.pandocPath = pandocPath; this.pythonPath = pythonPath; this.onEvent = onEvent; this.cacheRoot = cacheRoot;
    this.nodePath = nodePath;
    this.renderer = new MarkdownRenderer(pandocPath); this.project = null; this.revision = 0; this.epoch = 0;
    this.jobs = new Map(); this.queue = []; this.active = null; this.pumping = false; this.versions = new Map();
    this.watchers = new Map(); this.watchVersions = new Map(); this.watchPending = new Set(); this.watchTimer = null;
    this.watchWork = Promise.resolve();
    this.treeDirectories = new Set();
    this.outputFiles = new Set(); this.outputDirectories = new Set();
  }
  requireProject() { if (!this.project) throw error('NO_PROJECT', 'Open a document project first.'); return this.project; }
  isDeclaredInput(relative, descendants = false) {
    const key = fileKey(relative);
    return this.requireProject().files.some(file => fileKey(file.path) === key || (descendants && fileKey(file.path).startsWith(key + '/')));
  }
  async registerOutput(target) {
    const project = this.requireProject(), epoch = this.epoch;
    const absolute = path.resolve(target), relative = path.relative(project.root, absolute).replaceAll('\\', '/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return { registered: false };
    if (this.isDeclaredInput(relative)) throw error('OUTPUT_INPUT', 'A generated output cannot replace a declared document input.', { path: relative });
    const directories = [];
    for (let directory = path.dirname(absolute); fileKey(directory) !== fileKey(project.root); directory = path.dirname(directory)) {
      try { await fs.stat(directory); break; }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const parent = path.relative(project.root, directory).replaceAll('\\', '/');
        if (!this.isDeclaredInput(parent, true)) directories.push(fileKey(parent));
      }
    }
    if (project !== this.project || epoch !== this.epoch) throw error('SUPERSEDED', 'The project changed while preparing an output.');
    this.outputFiles.add(fileKey(relative)); for (const directory of directories) this.outputDirectories.add(directory);
    return { registered: true };
  }
  isOutputChange(relative) {
    const key = fileKey(relative);
    return (this.outputFiles.has(key) && !this.isDeclaredInput(relative)) ||
      (this.outputDirectories.has(key) && !this.isDeclaredInput(relative, true));
  }
  async resolve(relative, allowNew = false) {
    const root = this.requireProject().root; const p = path.resolve(root, relativePath(relative));
    if (!inside(root, p)) throw error('PATH', 'Path leaves the project folder.');
    let existing = p;
    for (;;) {
      try {
        const real = await fs.realpath(existing);
        if (!inside(root, real)) throw error('PATH', 'A linked project path points outside the project folder.', { path: relative });
        break;
      } catch (e) {
        if (e.code !== 'ENOENT' || !allowNew || existing === root) throw e;
        existing = path.dirname(existing);
      }
    }
    return p;
  }
  emit(job) { try { this.onEvent({ type: 'job', job: this.getJob(job.id) }); } catch {} }
  invalidate({ includeCommands = false } = {}) {
    this.revision++;
    for (const job of this.jobs.values()) if (!terminal.has(job.status) && (includeCommands || job.kind === 'build')) {
      if (job.status === 'queued') job.finished = true;
      job.status = 'superseded'; job.controller.abort(); job.diagnostics.push('A newer project revision replaced this request.'); this.emit(job);
    }
  }
  async createProject(root, options = {}) {
    const kind = options.kind || 'starter';
    if (!['blank', 'paper', 'patent', 'starter'].includes(kind)) throw error('CONFIG', 'Unknown document starter.');
    const templateConfig = JSON.parse(await fs.readFile(path.join(TEMPLATE, 'doconstruct.json'), 'utf8'));
    let sections = options.sections;
    if (sections !== undefined && !Array.isArray(sections)) throw error('CONFIG', 'Sections must be an ordered array.');
    if (sections === undefined && kind !== 'starter') sections = (SECTION_PRESETS[kind] || []).map(title => ({ title }));
    const config = validateConfig({ ...templateConfig, title: options.title || templateConfig.title,
      sections: sections === undefined ? templateConfig.sections : sections.map((section, i) => ({
        id: section.id || `section-${i + 1}`, title: section.title || `章节 ${i + 1}`,
        path: section.path || `sections/${String(i + 1).padStart(2, '0')}-section.md`, enabled: section.enabled !== false
      })) });
    await fs.mkdir(root, { recursive: true });
    if ((await fs.readdir(root)).length) throw error('EXISTS', 'Create a project in an empty folder.');
    for (const name of ['layout.py', 'layout.css'])
      await fs.copyFile(path.join(TEMPLATE, name), path.join(root, name));
    await fs.writeFile(path.join(root, 'doconstruct.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    for (const section of config.sections) {
      const destination = path.join(root, section.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const original = sections === undefined ? path.join(TEMPLATE, section.path) : null;
      await fs.writeFile(destination, original ? await fs.readFile(original) : `# ${section.title}\n\n`, { flag: 'wx' });
    }
    return this.openProject(root);
  }
  async openProject(root) {
    const stat = await fs.stat(root); const single = stat.isFile() ? path.basename(root) : null;
    const realRoot = await fs.realpath(single ? path.dirname(root) : root);
    const configFile = path.join(realRoot, 'doconstruct.json'); let config;
    try { config = JSON.parse(await fs.readFile(configFile, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw error('CONFIG', `Cannot read doconstruct.json: ${e.message}`);
      let sections = [];
      try {
        const old = JSON.parse(await fs.readFile(path.join(realRoot, 'sections.json'), 'utf8'));
        if (!Array.isArray(old.sections)) throw error('CONFIG', 'Legacy sections.json must contain a sections array.');
        for (const s of old.sections) for (const b of s.body || []) sections.push({ id: `section-${sections.length + 1}`, title: s.directory,
          path: path.posix.join('assets', relativePath(s.directory), relativePath(b)), enabled: true });
      } catch (e2) {
        if (e2.code !== 'ENOENT') throw error('CONFIG', `Cannot import sections.json: ${e2.message}`);
        const names = single ? [single] : (await fs.readdir(realRoot)).filter(x => /\.md$/i.test(x)).sort();
        sections = names.map((name, i) => ({ id: `section-${i + 1}`, title: path.basename(name, path.extname(name)), path: name, enabled: true }));
      }
      config = { version: 1, title: path.basename(realRoot), sections, style: DEFAULT_STYLE, stylesheet: 'layout.css', layoutScript: 'layout.py' };
      for (const name of ['layout.py', 'layout.css']) {
        try { await fs.writeFile(path.join(realRoot, name), await fs.readFile(path.join(TEMPLATE, name)), { flag: 'wx' }); }
        catch (auxError) { if (auxError.code !== 'EEXIST') throw auxError; }
      }
      await fs.writeFile(configFile, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    }
    const validated = validateConfig(config);
    const version = digest(await fs.readFile(configFile));
    this.closeWatchers(); this.treeDirectories.clear(); this.outputFiles.clear(); this.outputDirectories.clear();
    this.invalidate({ includeCommands: true }); this.epoch++; this.versions.clear();
    this.project = { root: realRoot, config: validated, version, latestPreview: null };
    await this.refreshFiles();
    await this.startWatching();
    return this.getProject();
  }
  async refreshFiles() {
    const project = this.requireProject();
    const selected = new Set(['doconstruct.json', ...project.config.sections.map(s => s.path), project.config.stylesheet, project.config.layoutScript].filter(Boolean));
    for (const entry of await fs.readdir(project.root, { withFileTypes: true }))
      if (entry.isFile() && !entry.name.startsWith('.') && EDITABLE.has(path.extname(entry.name).toLowerCase())) selected.add(entry.name);
    for (const arg of project.config.command?.argv || []) {
      if (EDITABLE.has(path.extname(arg).toLowerCase()) && !path.isAbsolute(arg)) {
        try { const p = relativePath(arg); if ((await fs.stat(await this.resolve(p))).isFile()) selected.add(p); } catch {}
      }
    }
    project.files = [...selected].map(p => ({ path: p, name: path.posix.basename(p),
      kind: project.config.sections.some(s => s.path === p) ? 'content' : 'file', language: language(p) }));
  }
  async getProject() {
    if (!this.project) return null;
    const project = this.project;
    return { root: project.root, title: project.config.title, config: copy(project.config), version: project.version,
      files: copy(project.files),
      latestPreview: project.latestPreview ? { ...project.latestPreview } : null, revision: this.revision };
  }
  closeWatchers() {
    clearTimeout(this.watchTimer); this.watchTimer = null; this.watchPending.clear();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear(); this.watchVersions.clear();
  }
  async fileVersion(relative, project = this.requireProject()) {
    try {
      const target = await fs.realpath(path.resolve(project.root, relativePath(relative)));
      if (!inside(project.root, target)) throw error('PATH', 'A linked project path points outside the project folder.');
      const stat = await fs.stat(target);
      if (stat.isDirectory()) return `directory:${stat.mtimeMs}`;
      if (!EDITABLE.has(path.extname(relative).toLowerCase())) {
        return `file:${stat.size}:${stat.mtimeMs}`;
      }
      return digest(await fs.readFile(target));
    }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async startWatching() {
    const project = this.requireProject(); const epoch = this.epoch;
    const versions = [];
    for (const file of project.files) if (!this.watchVersions.has(file.path)) versions.push([file.path, await this.fileVersion(file.path, project)]);
    if (project !== this.project || epoch !== this.epoch) return;
    for (const [relative, version] of versions) this.watchVersions.set(relative, version);
    const directories = new Set([project.root, ...this.treeDirectories]);
    for (const file of project.files) {
      let directory = path.dirname(path.resolve(project.root, file.path));
      while (inside(project.root, directory)) {
        directories.add(directory); if (directory === project.root) break; directory = path.dirname(directory);
      }
    }
    for (const [directory, watcher] of this.watchers) if (!directories.has(directory)) { watcher.close(); this.watchers.delete(directory); }
    for (const directory of directories) if (!this.watchers.has(directory)) {
      try {
        const watcher = watch(directory, { persistent: false }, (eventType, name) => {
          if (project !== this.project || epoch !== this.epoch) return;
          const relative = name ? path.relative(project.root, path.join(directory, String(name))).replaceAll('\\', '/') : null;
          if (relative && relative.split('/').some(part => INTERNAL.has(part))) return;
          if (relative && /\.doconstruct-[a-f0-9-]{36}\.tmp$/i.test(relative)) return;
          if (eventType === 'rename' && relative) {
            const target = path.resolve(project.root, relative);
            if (this.watchers.has(target)) { this.watchers.get(target).close(); this.watchers.delete(target); }
          }
          if (relative && (this.watchVersions.has(relative) || this.treeDirectories.has(directory))) this.watchPending.add(relative);
          else if (relative) {
            for (const file of project.files) if (file.path.startsWith(relative + '/')) this.watchPending.add(file.path);
            if (directory === project.root && !relative.startsWith('.') && EDITABLE.has(path.extname(relative).toLowerCase())) this.watchPending.add(relative);
          } else for (const file of project.files) this.watchPending.add(file.path);
          if (!this.watchPending.size) return;
          clearTimeout(this.watchTimer);
          this.watchTimer = setTimeout(() => {
            this.watchTimer = null; const paths = [...this.watchPending]; this.watchPending.clear();
            this.watchWork = this.watchWork.then(() => this.refreshProject({ paths, epoch, notify: true })).catch(e => {
              if (project === this.project && epoch === this.epoch) {
                this.invalidate();
                try { this.onEvent({ type: 'files-changed', project: null, paths, external: true,
                  error: { code: e.code || 'FILE_WATCH', message: e.message } }); } catch {}
              }
            });
          }, 80);
          this.watchTimer.unref?.();
        });
        watcher.on('error', () => { watcher.close(); this.watchers.delete(directory); });
        this.watchers.set(directory, watcher);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  async refreshProject({ paths, epoch = this.epoch, notify = false } = {}) {
    const project = this.requireProject();
    const changed = [];
    for (const relative of paths || project.files.map(file => file.path)) {
      const token = await this.fileVersion(relative, project);
      if (project !== this.project || epoch !== this.epoch) return this.getProject();
      if (token !== this.watchVersions.get(relative)) { changed.push(relative); this.watchVersions.set(relative, token); }
    }
    if (!changed.length) { await this.startWatching(); return this.getProject(); }
    if (changed.includes('doconstruct.json')) {
      let config;
      try { config = validateConfig(JSON.parse(await fs.readFile(path.join(project.root, 'doconstruct.json'), 'utf8'))); }
      catch (e) { this.watchVersions.delete('doconstruct.json'); throw error('CONFIG', `Cannot reload doconstruct.json: ${e.message}`); }
      if (project !== this.project || epoch !== this.epoch) return this.getProject();
      project.config = config; project.version = this.watchVersions.get('doconstruct.json');
    }
    for (const relative of changed) this.versions.set(relative, this.watchVersions.get(relative));
    const sourceChanged = changed.some(relative => !this.isOutputChange(relative));
    if (sourceChanged) this.invalidate();
    await this.refreshFiles(); await this.startWatching();
    const dto = await this.getProject();
    if (notify && project === this.project && epoch === this.epoch)
      try { this.onEvent({ type: 'files-changed', project: dto, paths: changed, external: true, sourceChanged }); } catch {}
    return dto;
  }
  async createSection({ title, path: requestedPath, content } = {}) {
    const project = this.requireProject();
    title = typeof title === 'string' && title.trim() ? title.trim() : '新章节';
    let relative = requestedPath ? relativePath(requestedPath) : null;
    if (!relative) {
      for (let i = project.config.sections.length + 1; ; i++) {
        const candidate = `sections/${String(i).padStart(2, '0')}-section.md`;
        if (!await this.fileVersion(candidate)) { relative = candidate; break; }
      }
    }
    if (!['.md', '.txt'].includes(path.extname(relative).toLowerCase())) throw error('PATH', 'A section must use .md or .txt.');
    if (project.config.sections.some(section => section.path === relative)) throw error('EXISTS', 'This file is already in the document skeleton.');
    if (content !== undefined && typeof content !== 'string') throw error('CONTENT', 'Section content must be text.');
    const present = await this.fileVersion(relative);
    if (present !== null && content !== undefined) throw error('CONFLICT', 'The section file already exists. Add it without content to preserve it, or edit it using its opened version.');
    const token = present ?? await this.atomicWrite(relative, content ?? `# ${title}\n\n`, null);
    this.watchVersions.set(relative, token);
    const config = copy(project.config);
    config.sections.push({ id: `section-${randomUUID()}`, title, path: relative, enabled: true });
    return this.saveConfig({ config, version: project.version });
  }
  async listDirectory({ path: relative = '' } = {}) {
    const project = this.requireProject(); const directory = relative ? await this.resolve(relative) : project.root;
    if (!(await fs.stat(directory)).isDirectory()) throw error('PATH', 'Select a directory.');
    const entries = [];
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (INTERNAL.has(item.name)) continue;
      const child = path.relative(project.root, path.join(directory, item.name)).replaceAll('\\', '/');
      let stat;
      try { stat = await fs.stat(await this.resolve(child)); } catch { continue; }
      if (!stat.isFile() && !stat.isDirectory()) continue;
      entries.push({ name: item.name, path: child, type: stat.isDirectory() ? 'directory' : 'file',
        extension: stat.isFile() ? path.extname(item.name).toLowerCase() : '', ...(stat.isFile() ? { size: stat.size } : {}) });
      if (!this.watchVersions.has(child)) this.watchVersions.set(child, await this.fileVersion(child, project));
    }
    this.treeDirectories.add(directory); await this.startWatching();
    entries.sort((a, b) => (a.type === b.type ? 0 : a.type === 'directory' ? -1 : 1) || a.name.localeCompare(b.name));
    return { path: relative.replaceAll('\\', '/'), entries };
  }
  editableEntry(relative) {
    const normalized = relativePath(relative);
    if (normalized === '.' || normalized.split('/').some(part => INTERNAL.has(part))) throw error('PATH', 'Internal application folders cannot be changed here.');
    return normalized;
  }
  async createDirectory({ path: relative } = {}) {
    relative = this.editableEntry(relative);
    const target = await this.resolve(relative, true);
    await fs.mkdir(target); await this.startWatching();
    return { path: relative };
  }
  async renameEntry({ path: relative, newPath } = {}) {
    relative = this.editableEntry(relative); newPath = this.editableEntry(newPath);
    if (relative === 'doconstruct.json' || newPath === 'doconstruct.json') throw error('PATH', 'The project manifest must keep its filename.');
    if (newPath.startsWith(relative + '/')) throw error('PATH', 'A directory cannot be moved inside itself.');
    const project = this.requireProject(); const source = await this.resolve(relative); const destination = await this.resolve(newPath, true);
    try { await fs.lstat(destination); throw error('EXISTS', 'The destination already exists.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const moved = p => p === relative || p.startsWith(relative + '/') ? newPath + p.slice(relative.length) : p;
    const config = copy(project.config);
    for (const section of config.sections) section.path = moved(section.path);
    for (const key of ['layoutScript', 'stylesheet']) if (config[key]) config[key] = moved(config[key]);
    if (config.command) {
      config.command.argv = config.command.argv.map(moved);
      config.command.outputs = config.command.outputs.map(moved);
    }
    validateConfig(config);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
    let dto;
    try { dto = await this.saveConfig({ config, version: project.version }); }
    catch (e) { await fs.rename(destination, source); throw e; }
    for (const folder of [...this.treeDirectories]) if (folder === source || folder.startsWith(source + path.sep)) {
      this.treeDirectories.delete(folder); this.treeDirectories.add(destination + folder.slice(source.length));
    }
    await this.startWatching();
    try { this.onEvent({ type: 'files-changed', project: dto, paths: [relative, newPath], external: false }); } catch {}
    return dto;
  }
  async removeEntry({ path: relative } = {}) {
    relative = this.editableEntry(relative); const project = this.requireProject();
    const contains = p => p === relative || p.startsWith(relative + '/');
    if (relative === 'doconstruct.json' || [project.config.layoutScript, project.config.stylesheet].filter(Boolean).some(contains))
      throw error('PATH', 'The manifest and current layout files cannot be removed. Change the layout configuration first.');
    const source = await this.resolve(relative);
    const trashPath = `.doconstruct/trash/${randomUUID()}/${path.posix.basename(relative)}`;
    const destination = await this.resolve(trashPath, true);
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.rename(source, destination);
    const config = copy(project.config); config.sections = config.sections.filter(section => !contains(section.path));
    let dto;
    try { dto = await this.saveConfig({ config, version: project.version }); }
    catch (e) { await fs.rename(destination, source); throw e; }
    for (const folder of [...this.treeDirectories]) if (folder === source || folder.startsWith(source + path.sep)) this.treeDirectories.delete(folder);
    await this.startWatching();
    try { this.onEvent({ type: 'files-changed', project: dto, paths: [relative], external: false }); } catch {}
    return { project: dto, trashPath };
  }
  async readFile(relative) {
    const p = await this.resolve(relative);
    if (BINARY.has(path.extname(relative).toLowerCase())) throw error('BINARY', 'This resource is not an editable text document. Open it with the resource viewer.');
    const bytes = await fs.readFile(p); const version = digest(bytes); let content;
    try {
      if (bytes.includes(0)) throw new Error('NUL byte');
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch { throw error('BINARY', 'This file is binary or is not UTF-8 text. Open it with the resource viewer.'); }
    return { path: relative.replaceAll('\\', '/'), content, version, language: language(relative) };
  }
  async atomicWrite(relative, content, version) {
    const p = await this.resolve(relative, true); let old = null;
    try { old = digest(await fs.readFile(p)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (old !== (version ?? null)) throw error('CONFLICT', 'The file changed outside this editor. Reload before saving.', { path: relative });
    await fs.mkdir(path.dirname(p), { recursive: true });
    const temp = `${p}.doconstruct-${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, content, 'utf8');
      let current = null; try { current = digest(await fs.readFile(p)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (current !== old) throw error('CONFLICT', 'The file changed while it was being saved.', { path: relative });
      await fs.rename(temp, p);
    } finally { await fs.rm(temp, { force: true }); }
    return digest(Buffer.from(content));
  }
  async saveFile({ path: relative, content, version }) {
    if (typeof content !== 'string') throw error('CONTENT', 'File content must be text.');
    if (relative === 'doconstruct.json') {
      const project = await this.saveConfig({ config: JSON.parse(content), version }); return { path: relative, version: project.version };
    }
    const token = await this.atomicWrite(relative, content, version); this.versions.set(relative, token); this.watchVersions.set(relative, token); this.invalidate();
    if (!this.project.files.some(f => f.path === relative)) this.project.files.push({ path: relative, name: path.posix.basename(relative), kind: 'file', language: language(relative) });
    await this.startWatching();
    return { path: relative, version: token };
  }
  async saveConfig({ config, version }) {
    const next = validateConfig(config); const token = await this.atomicWrite('doconstruct.json', JSON.stringify(next, null, 2) + '\n', version);
    this.project.config = next; this.project.version = token; this.versions.set('doconstruct.json', token); this.watchVersions.set('doconstruct.json', token); this.invalidate(); await this.refreshFiles(); await this.startWatching(); return this.getProject();
  }
  async snapshot() {
    await this.refreshProject();
    const project = this.requireProject(); const epoch = this.epoch; const config = copy(project.config);
    const paths = [...new Set(['doconstruct.json', ...config.sections.filter(s => s.enabled).map(s => s.path), config.stylesheet, config.layoutScript].filter(Boolean))];
    const files = new Map(); let externallyChanged = false;
    for (const p of paths) {
      const text = await this.readFile(p); files.set(p, text);
      if (this.versions.has(p) && this.versions.get(p) !== text.version) externallyChanged = true;
      this.versions.set(p, text.version);
    }
    if (epoch !== this.epoch) throw error('SUPERSEDED', 'Project changed while collecting build inputs.');
    if (files.get('doconstruct.json').version !== project.version) throw error('CONFLICT', 'doconstruct.json changed externally. Reopen the project to load its configuration.');
    if (externallyChanged) this.invalidate();
    return { root: project.root, epoch, revision: this.revision, config, files,
      sections: config.sections.filter(s => s.enabled).map(s => ({ ...s, markdown: files.get(s.path).content })) };
  }
  makeJob(kind, revision, payload) {
    const job = { id: randomUUID(), revision, kind, payload, status: 'queued', stage: 'queued', finished: false, logs: [], diagnostics: [],
      stats: { renderedSections: 0, cachedSections: 0, elapsedMs: 0 }, controller: new AbortController() };
    this.jobs.set(job.id, job); this.queue.push(job); this.emit(job); this.pump(); return { jobId: job.id, revision };
  }
  async build({ runLayoutScript = true } = {}) {
    const snapshot = await this.snapshot();
    for (const job of this.jobs.values()) if (job.kind === 'build' && !terminal.has(job.status)) {
      job.status = 'superseded'; job.controller.abort(); this.emit(job);
    }
    return this.makeJob('build', snapshot.revision, { snapshot, runLayoutScript });
  }
  getJob(id) {
    const j = this.jobs.get(id); if (!j) throw error('NOT_FOUND', 'Task does not exist.');
    return copy(Object.fromEntries(Object.entries(j).filter(([k]) => !['controller', 'payload', 'kind'].includes(k))));
  }
  cancelJob(id) {
    const j = this.jobs.get(id); if (!j || terminal.has(j.status)) return { canceled: false };
    if (j.status === 'queued') j.finished = true;
    j.status = 'canceled'; j.controller.abort(); this.emit(j); return { canceled: true };
  }
  stage(job, value) { job.stage = value; this.emit(job); }
  log(job, stream, value) {
    for (const line of value.split(/\r?\n/)) if (line) job.logs.push(`${stream}: ${line}`);
    if (job.logs.length > 1000) job.logs.splice(0, job.logs.length - 1000);
  }
  async pump() {
    if (this.pumping) return; this.pumping = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift(); if (terminal.has(job.status)) { job.payload = null; job.finished = true; continue; }
        this.active = job; job.status = 'running'; const start = performance.now(); this.emit(job);
        try {
          if (job.kind === 'build') await this.executeBuild(job); else await this.executeCommand(job);
          if (!terminal.has(job.status)) { job.status = 'completed'; job.stage = 'completed'; }
        } catch (e) {
          if (!terminal.has(job.status)) job.status = e.code === 'CANCELED' ? 'canceled' : e.code === 'SUPERSEDED' ? 'superseded' : 'failed';
          job.error = { code: e.code || 'COMMAND', message: e.message, details: e.details };
          if (job.kind === 'command' && e.details) {
            for (const key of ['stdout', 'stderr', 'exitCode', 'signal']) if (key in e.details) job[key] = e.details[key];
          }
          job.diagnostics.push(e.message); if (e.details?.stderr) this.log(job, 'stderr', e.details.stderr); if (e.details?.stdout) this.log(job, 'stdout', e.details.stdout);
        } finally { job.stats.elapsedMs = Math.round((performance.now() - start) * 10) / 10; job.payload = null; this.active = null; job.finished = true; this.emit(job); }
      }
    } finally { this.pumping = false; }
  }
  async executeBuild(job) {
    const { snapshot: s, runLayoutScript } = job.payload; const signal = job.controller.signal;
    const log = (stream, text) => this.log(job, stream, text);
    const parsed = await this.renderer.render(s.config, s.sections, { cwd: s.root, signal, onStage: stage => this.stage(job, stage), onLog: log });
    Object.assign(job.stats, parsed.stats); this.stage(job, 'layout');
    const context = { title: s.config.title, language: 'zh-CN', style: s.config.style, sections: parsed.sections,
      baseUrl: pathToFileURL(s.root + path.sep).href,
      css: documentCss(s.config.style) + '\n' + (s.files.get(s.config.stylesheet)?.content || '') };
    let html;
    if (runLayoutScript && s.config.layoutScript && this.pythonPath) {
      const scriptText = s.files.get(s.config.layoutScript).content;
      // Run the captured script bytes: edits during a job cannot silently change its implementation.
      const folder = await this.jobDirectory(job, s.root); const script = path.join(folder, 'layout.py');
      await fs.writeFile(script, scriptText, 'utf8');
      try {
        const original = path.resolve(s.root, s.config.layoutScript);
        const bootstrap = 'import sys,pathlib;source=pathlib.Path(sys.argv[2]).read_text(encoding="utf-8");original=sys.argv[3];sys.path.insert(0,sys.argv[1]);sys.argv=[original];exec(compile(source,original,"exec"),{"__name__":"__main__","__file__":original})';
        const result = await runProcess(this.pythonPath, ['-X', 'utf8', '-c', bootstrap, path.dirname(original), script, original], { cwd: s.root, input: JSON.stringify(context), signal, onLog: (stream, text) => { if (stream === 'stderr') log(stream, text); } });
        html = result.stdout;
      } catch (e) {
        if (e.code !== 'PROCESS_START' || e.details?.systemCode !== 'ENOENT') throw e;
        job.diagnostics.push('Configured Python was not found; using the built-in layout. Select an available interpreter in Dependencies.');
        html = defaultDocument(context);
      }
      if (!html.trim()) throw error('LAYOUT', 'The layout script returned no HTML. Write the complete HTML document to stdout.');
    } else {
      if (runLayoutScript && s.config.layoutScript && !this.pythonPath) job.diagnostics.push('Python is unavailable; using the built-in layout. Configure Python in Dependencies to run the editable layout script.');
      html = defaultDocument(context);
    }
    if (!/<base[\s>]/i.test(html)) {
      const base = `<base href="${context.baseUrl}">`;
      html = /<head[\s>]/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${base}`)
        : html.replace(/^(\s*<!doctype[^>]*>)?/i, `$1${base}`);
    }
    if (signal.aborted) throw error('CANCELED', 'Task canceled.');
    for (const [p, file] of s.files) {
      const current = await fs.readFile(await this.resolve(p));
      if (digest(current) !== file.version) throw error('SUPERSEDED', `Build input changed externally: ${p}`);
    }
    if (s.epoch !== this.epoch || s.revision !== this.revision) throw error('SUPERSEDED', 'A newer project revision replaced this build.');
    const folder = await this.jobDirectory(job, s.root); const target = path.join(folder, 'preview.html');
    await fs.writeFile(target + '.tmp', html, 'utf8'); await fs.rename(target + '.tmp', target);
    job.htmlPath = target; this.project.latestPreview = { jobId: job.id, revision: job.revision, htmlPath: target };
  }
  async jobDirectory(job, root) {
    const folder = path.join(this.cacheRoot || path.join(root, '.doconstruct', 'cache'), digest(root).slice(0, 12), job.id);
    await fs.mkdir(folder, { recursive: true }); return folder;
  }
  async runCommand({ argv, cwd = '.', outputs, publishPreview = true } = {}) {
    const project = this.requireProject(); const command = project.config.command;
    outputs ??= argv === undefined ? command?.outputs || [] : [];
    argv ??= command?.argv;
    if (!Array.isArray(argv) || !argv.length || argv.some(x => typeof x !== 'string' || x.includes('\0')) || !argv[0].trim()) throw error('COMMAND', 'Provide a command as an executable and separate argv strings.');
    if (!Array.isArray(outputs) || outputs.some(p => typeof p !== 'string')) throw error('COMMAND', 'Outputs must be project file paths.');
    argv = [...argv]; const first = argv[0].toLowerCase(); let env;
    if (['{python}', 'python', 'python3', 'python.exe'].includes(first)) {
      if (!this.pythonPath) throw error('DEPENDENCY', 'Python is unavailable. Select an available interpreter in Dependencies.');
      argv[0] = this.pythonPath;
    } else if (['{pandoc}', 'pandoc', 'pandoc.exe'].includes(first)) {
      if (!this.pandocPath) throw error('DEPENDENCY', 'Pandoc is unavailable. Check the bundled runtime in Dependencies.');
      argv[0] = this.pandocPath;
    } else if (['{node}', 'node', 'node.exe'].includes(first)) {
      argv[0] = this.nodePath; env = { ELECTRON_RUN_AS_NODE: '1' };
    }
    const directory = cwd === '.' ? project.root : await this.resolve(cwd);
    if (!(await fs.stat(directory)).isDirectory()) throw error('PATH', 'The command working directory must be a directory.');
    const paths = await Promise.all(outputs.map(p => this.resolve(p, true)));
    if (project !== this.project) throw error('SUPERSEDED', 'The selected project changed while preparing the command.');
    return this.makeJob('command', this.revision, { root: project.root, epoch: this.epoch, argv, env, cwd: directory, outputs: paths, publishPreview });
  }
  async executeCommand(job) {
    this.stage(job, 'command'); const p = job.payload;
    job.argv = p.argv; job.cwd = p.cwd;
    Object.assign(job, await runProcess(p.argv[0], p.argv.slice(1), { cwd: p.cwd, env: p.env, signal: job.controller.signal, onLog: (stream, text) => this.log(job, stream, text) }));
    job.artifacts = [];
    for (const target of p.outputs) {
      let real;
      try { real = await fs.realpath(target); if (!(await fs.stat(real)).isFile()) throw new Error('The output is not a file.'); }
      catch (e) { throw error('OUTPUT_MISSING', `Declared output was not produced: ${target}`, { output: target, reason: e.message }); }
      if (!inside(p.root, real)) throw error('PATH', 'A declared output points outside the project folder.', { output: target });
      job.artifacts.push(target);
    }
    if (job.controller.signal.aborted) throw error('CANCELED', 'Task canceled.');
    if (p.epoch !== this.epoch) throw error('SUPERSEDED', 'The selected project changed during this command.');
    if (p.publishPreview) {
      job.htmlPath = job.artifacts.find(target => /\.html?$/i.test(target));
      job.pdfPath = job.artifacts.find(target => /\.pdf$/i.test(target));
      if (job.htmlPath) this.project.latestPreview = { jobId: job.id, revision: job.revision, htmlPath: job.htmlPath };
    }
  }
  dispose() { this.closeWatchers(); this.outputFiles.clear(); this.outputDirectories.clear(); this.epoch++; for (const job of this.jobs.values()) if (!terminal.has(job.status)) this.cancelJob(job.id); }
}

export { BackendError };
