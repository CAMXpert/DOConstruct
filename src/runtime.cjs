const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const execute = promisify(execFile);

function onPath(names) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveRuntime(app) {
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources');
  const choose = (name, configured, relative, names) => {
    const bundled = path.join(resources, 'vendor', ...relative);
    if (configured) return { name, available: fs.existsSync(configured), source: 'configured', path: configured,
      message: fs.existsSync(configured) ? '' : '配置的可执行文件不存在。' };
    if (fs.existsSync(bundled)) return { name, available: true, source: 'bundled', path: bundled };
    const found = onPath(names);
    return { name, available: !!found, source: 'system', path: found, message: found ? '' : '未发现可用依赖。请安装完整发行包，或配置可执行文件。' };
  };
  const pandoc = choose('Pandoc', process.env.DOCONSTRUCT_PANDOC,
    ['pandoc', process.platform === 'win32' ? 'pandoc.exe' : 'pandoc'], ['pandoc.exe', 'pandoc']);
  const python = choose('Python', process.env.DOCONSTRUCT_PYTHON,
    ['python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'], ['python.exe', 'python3', 'python']);
  return { resources, pandoc, python };
}

async function inspectRuntime(app, runtime, config = {}) {
  const items = [
    { name: 'DOConstruct / Electron', available: true, source: 'bundled', version: process.versions.electron },
    { name: 'Chromium / PDF', available: true, source: 'bundled', version: process.versions.chrome },
    { name: 'CodeMirror', available: true, source: 'bundled', message: '本地编辑器资源，无需 CDN' }
  ];
  for (const entry of [runtime.pandoc, runtime.python]) {
    const item = { ...entry };
    if (entry.available) {
      try {
        const result = await execute(entry.path, ['--version'], { timeout: 10000, windowsHide: true });
        item.version = (result.stdout || result.stderr).split(/\r?\n/)[0];
      } catch (error) { item.available = false; item.message = error.message; }
    }
    items.push(item);
  }
  const modules = config.pythonModules || [];
  if (modules.length && runtime.python.available) {
    try {
      const program = 'import importlib.util,json,sys\nr=[]\nfor n in json.loads(sys.argv[1]):\n try: ok=importlib.util.find_spec(n) is not None\n except (ImportError,ModuleNotFoundError,ValueError): ok=False\n r.append({"name":n,"available":ok})\nprint(json.dumps(r))';
      const result = await execute(runtime.python.path, ['-c', program, JSON.stringify(modules)],
        { timeout: 15000, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
      items.push(...JSON.parse(result.stdout).map(item => ({ ...item, source: 'configured', message: '项目声明的 Python 模块' })));
    } catch (error) { items.push({ name: '项目 Python 模块检查', available: false, source: 'configured', message: error.message }); }
  }
  return { items, packaged: app.isPackaged, resources: runtime.resources };
}

module.exports = { resolveRuntime, inspectRuntime };
