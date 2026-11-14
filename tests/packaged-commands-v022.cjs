const { _electron } = require('playwright-core');
const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const root = path.resolve(__dirname, '..');
const stage = path.join(root, 'build', 'release-v022', 'packaged-check');
const checks = [], results = [];
let app, page, server, mode = 'allowed', round = 0;
const check = (condition, name) => { if (!condition) throw Error(name); checks.push(name); };
const tool = (name, args) => ({ id: `${mode}-${round}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function call(method, args = {}) {
  const result = await page.evaluate(([m, a]) => window.doconstruct.invoke(m, a), [method, args]);
  if (!result.ok) throw Error(JSON.stringify(result.error)); return result;
}
async function launch(profile) {
  app = await _electron.launch({ executablePath: path.join(root, 'dist', 'win-unpacked', 'DOConstruct.exe'), args: ['--user-data-dir=' + profile], timeout: 60000 });
  page = await app.firstWindow(); await page.waitForSelector('.cm-editor');
  await page.evaluate(() => { window.__events = []; window.doconstruct.onEvent(e => window.__events.push(e)); });
}
async function task(message) {
  const id = (await call('ai.send', { message })).jobId;
  await page.waitForFunction(id => window.__events.some(e => e.type === 'ai' && e.job.id === id && ['completed', 'failed', 'canceled'].includes(e.job.status)), id, { timeout: 30000 });
  return (await page.evaluate(id => window.__events.filter(e => e.type === 'ai' && e.job.id === id).at(-1).job, id));
}
(async () => {
  await fs.mkdir(stage, { recursive: true });
  server = http.createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text), last = body.messages.at(-1);
      if (last.role === 'tool') results.push({ mode, result: JSON.parse(last.content) });
      const advertised = body.tools.map(t => t.function.name);
      let calls;
      if (mode === 'allowed') {
        check(advertised.includes('run_project_command') && advertised.includes('run_shell_command'), 'Enabled tools advertised');
        if (round === 0) calls = [tool('run_project_command', { argv: ['{python}', '-c', 'from pathlib import Path;import time;Path("command-output.md").write_text("command-file-written",encoding="utf-8");print("bundled-python 中文");time.sleep(0.8)'] })];
        else if (round === 1) calls = [tool('run_shell_command', { command: 'Write-Output "PowerShell 中文"; [Console]::Error.WriteLine("expected stderr"); exit 7' })];
        else if (round === 2) calls = [tool('run_project_command', { argv: ['{node}', '-e', 'console.log("bundled-node " + process.versions.node)'] })];
      } else if (mode === 'disabled') {
        check(!advertised.includes('run_project_command') && !advertised.includes('run_shell_command'), 'Disabled command tools omitted');
        if (round === 0) calls = [tool('run_project_command', { argv: ['{node}', '-e', 'require("fs").writeFileSync("must-not-exist.txt","denied")'] })];
        else if (round === 1) calls = [tool('run_shell_command', { command: 'Set-Content must-not-exist-shell.txt denied' })];
      } else if (mode === 'cancel' && round === 0) calls = [tool('run_shell_command', { command: 'Set-Content cancel-ready.txt ready; Start-Sleep -Seconds 30; Set-Content must-not-exist-after-cancel.txt wrong' })];
      round++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: calls ? null : '## 檢查完成\n\n命令已實際執行，預覽未更新。', ...(calls ? { tool_calls: calls } : {}) } }] }));
    } catch (error) { res.statusCode = 500; res.end(error.stack); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = await fs.mkdtemp(path.join(stage, 'profile-'));
  const project = await fs.mkdtemp(path.join(stage, 'project-'));
  await launch(profile);
  const info = await call('app.info'); check(info.packaged && info.version === '0.2.2', 'Real packaged DOConstruct 0.2.2');
  await call('project.new', { path: project, options: { kind: 'blank', title: '命令權限實際驗證' } });
  check(!(await call('project.get')).config.command, 'Fixture has no configured command');
  await call('ai.configure', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-command-check', apiMode: 'chat-completions', allowProjectCommands: true });
  await page.locator('#toggle-ai').click();
  const before = (await call('project.get')).latestPreview;
  const completed = await task('執行 Python、PowerShell 與 Node 測試，保留錯誤輸出。');
  check(completed.status === 'completed', 'Real HTTP tool loop completes');
  check(await fs.readFile(path.join(project, 'command-output.md'), 'utf8') === 'command-file-written', 'Command writes actual project file without self-cancel');
  const allowed = results.filter(r => r.mode === 'allowed').map(r => r.result);
  check(allowed.length === 3, 'Three real command results return to model');
  check(allowed[0].status === 'completed' && allowed[0].stdout.includes('bundled-python 中文') && allowed[0].exitCode === 0, 'Bundled Python argv stdout/exit succeed');
  check(allowed[1].status === 'failed' && allowed[1].exitCode === 7 && allowed[1].stderr.includes('expected stderr') && allowed[1].stdout.includes('PowerShell 中文'), 'PowerShell UTF-8, stderr and nonzero exit returned');
  check(allowed[2].status === 'completed' && allowed[2].stdout.includes('bundled-node'), 'Bundled Node alias executes');
  check(allowed.every(r => path.resolve(r.cwd) === path.resolve(project)), 'Actual working directory returned');
  check(completed.toolCalls[1].status === 'failed', 'UI execution record marks failed command correctly');
  check(JSON.stringify((await call('project.get')).latestPreview) === JSON.stringify(before), 'No automatic layout preview');
  await page.locator('#ai-execution').evaluate(e => { e.open = true; });
  await page.waitForSelector('#ai-tools details');
  await page.locator('#ai-tools details').first().evaluate(e => { e.open = true; });
  await page.screenshot({ path: path.join(stage, 'commands.png') });
  mode = 'disabled'; round = 0;
  await call('ai.configure', { allowProjectCommands: false });
  const disabled = await task('禁止命令測試'); check(disabled.status === 'completed', 'Permission errors return to model');
  check(results.filter(r => r.mode === 'disabled').every(r => r.result.error.code === 'AI_COMMAND_DISABLED'), 'Both tools enforce disabled permission');
  for (const name of ['must-not-exist.txt', 'must-not-exist-shell.txt']) {
    try { await fs.access(path.join(project, name)); throw Error('Disabled command executed'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  mode = 'cancel'; round = 0; await call('ai.configure', { allowProjectCommands: true });
  const cancelId = (await call('ai.send', { message: '取消測試' })).jobId;
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try { await fs.access(path.join(project, 'cancel-ready.txt')); ready = true; break; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  check(ready, 'PowerShell actually starts before cancellation');
  const cancelStart = Date.now(); await call('ai.cancel', { id: cancelId });
  check(Date.now() - cancelStart < 10000, 'Cancel stops running PowerShell promptly');
  check((await call('ai.history')).activeJob.status === 'canceled', 'Cancellation finishes AI finalization');
  await app.close(); app = null;
  await launch(profile); const settings = (await call('ai.settings')).settings;
  check(settings.allowProjectCommands === true, 'Command permission persists through restart');
  check(settings.model === 'local-command-check', 'Connection settings retained on restart');
  await fs.writeFile(path.join(stage, 'CLOSED.json'), JSON.stringify({ ok: true, checks, info, results, screenshot: path.join(stage, 'commands.png'), note: 'Real package; isolated profile/project; local HTTP fixture; no user credentials or live installation changed.' }, null, 2));
  await app.close(); app = null; server.closeAllConnections(); await new Promise(r => server.close(r));
  console.log('PACKAGED COMMAND PASS', checks.length);
})().catch(async error => {
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, 'CLOSED.json'), JSON.stringify({ ok: false, checks, results, error: error.stack }, null, 2));
  try { await page?.screenshot({ path: path.join(stage, 'failure.png') }); } catch {}
  try { await app?.close(); } catch {} server?.closeAllConnections(); server?.close();
  console.error(error); process.exitCode = 1;
});
