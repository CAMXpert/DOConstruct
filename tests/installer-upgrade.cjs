// Exercise the production Inno upgrade directives with a tiny isolated payload.
// Unique AppId/name: never installs over the user's DOConstruct or its settings.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const run = (exe, argv) => {
  const r = spawnSync(exe, argv, { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`${exe}: ${r.error?.message || r.status}\n${r.stdout || ''}\n${r.stderr || ''}`);
  return r.stdout;
};
(async () => {
  if (process.platform !== 'win32') throw new Error('Windows installer check requires Windows.');
  const stage = await fs.mkdtemp(path.join(root, 'build', 'installer-upgrade-'));
  const identity = randomUUID().toUpperCase(), appName = `DOConstruct Upgrade Check ${identity.slice(0, 8)}`;
  const payload = path.join(stage, 'payload'), install = path.join(stage, 'installed'), unused = path.join(stage, 'unused-default');
  const registryKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${identity}}_is1`;
  const report = { ok: false, stage, identity, checks: [] };
  let installed = false;
  try {
    const original = await fs.readFile(path.join(root, 'scripts', 'installer.iss'), 'utf8');
    if (!original.includes('AppId={{DBED5595-9D2A-4DB7-9BDD-76E2D9293047}')) throw Error('Production AppId changed.');
    if (/\[InstallDelete\]|\[UninstallDelete\]|\[Code\]/i.test(original)) throw Error('Review unexpected cleanup/code before upgrade test.');
    await fs.mkdir(path.join(payload, 'resources'), { recursive: true });
    await fs.copyFile(path.join(root, 'resources', 'icon.ico'), path.join(payload, 'resources', 'icon.ico'));
    const profile = path.join(stage, 'user-data'), project = path.join(stage, 'document-project');
    await fs.mkdir(profile); await fs.mkdir(project);
    await fs.writeFile(path.join(profile, 'settings.json'), 'preserved-profile');
    await fs.writeFile(path.join(project, 'paper.md'), 'preserved-project');
    for (const version of ['0.2.1', '0.2.2']) {
      await fs.writeFile(path.join(payload, 'DOConstruct.exe'), `isolated payload ${version}`);
      const script = original
        .replace(/^#define AppName .+$/m, `#define AppName "${appName}"`)
        .replace(/^#define AppVersion .+$/m, `#define AppVersion "${version}"`)
        .replace(/^#define Root .+$/m, `#define Root "${root}\\"`)
        .replace(/^#define AppSource .+$/m, `#define AppSource "${payload}"`)
        .replace(/^AppId=.+$/m, `AppId={{${identity}}`)
        .replace(/^VersionInfoVersion=.+$/m, `VersionInfoVersion=${version}.0`)
        .replace(/^DefaultDirName=.+$/m, `DefaultDirName=${unused}`)
        .replace(/^OutputDir=.+$/m, `OutputDir=${stage}`);
      const file = path.join(stage, `check-${version}.iss`);
      await fs.writeFile(file, script, 'utf8');
      run(path.join(root, '.tools', 'innosetup', 'ISCC.exe'), [file]);
      const installer = path.join(stage, `DOConstruct-Setup-${version}-x64.exe`);
      const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=', `/LOG=${path.join(stage, `install-${version}.log`)}`];
      if (version === '0.2.1') args.push(`/DIR=${install}`);
      run(installer, args); installed = true;
      if (await fs.readFile(path.join(install, 'DOConstruct.exe'), 'utf8') !== `isolated payload ${version}`) throw Error(`Payload ${version} did not update the original directory.`);
      if (!(await fs.readFile(path.join(profile, 'settings.json'), 'utf8') === 'preserved-profile' && await fs.readFile(path.join(project, 'paper.md'), 'utf8') === 'preserved-project')) throw Error('User data changed.');
      const values = run('reg.exe', ['query', registryKey]);
      if (!values.includes(version) || !values.includes(install)) throw Error('Uninstall metadata does not match the installed upgrade.');
      report.checks.push(`${version}: original install path and payload correct; settings/project preserved; uninstall metadata updated`);
    }
    try { await fs.access(unused); throw Error('Upgrade ignored previous install location.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    report.checks.push('Second installer omitted /DIR and automatically reused previous installation; no manual uninstall');
    report.ok = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    if (installed) {
      // Native uninstaller belongs to this verified unique test directory only.
      if (!path.resolve(install).startsWith(stage + path.sep)) throw Error('Invalid test uninstall path.');
      try { run(path.join(install, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']); report.cleaned = true; }
      catch (e) { report.cleanupError = e.message; report.ok = false; }
    }
    await fs.writeFile(path.join(stage, 'CLOSED.json'), JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
  console.log(JSON.stringify(report));
})().catch(e => { console.error(e); process.exitCode = 1; });
