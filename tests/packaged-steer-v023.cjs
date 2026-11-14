const { _electron } = require('playwright-core');
const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const root = path.resolve(__dirname, '..'), stage = path.join(root, 'build', 'release-v023', 'packaged-check');
let app, page, server, rounds = 0, releaseFirst, releaseSecond, firstSeen, secondSeen;
const first = new Promise(r => { firstSeen = r; }), firstGate = new Promise(r => { releaseFirst = r; });
const second = new Promise(r => { secondSeen = r; }), secondGate = new Promise(r => { releaseSecond = r; });
const checks = [];
const check = (condition, name) => { if (!condition) throw Error(name); checks.push(name); };
const tool = (name, args = {}) => ({ id: `call-${rounds}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function call(method, args = {}) {
  const result = await page.evaluate(([m, a]) => window.doconstruct.invoke(m, a), [method, args]);
  if (!result.ok) throw Error(JSON.stringify(result.error)); return result;
}
async function launch(profile) {
  app = await _electron.launch({ executablePath: path.join(root, 'dist', 'win-unpacked', 'DOConstruct.exe'), args: ['--user-data-dir=' + profile], timeout: 60000 });
  page = await app.firstWindow(); await page.waitForSelector('.cm-editor');
  await page.evaluate(() => { window.__events = []; window.doconstruct.onEvent(e => window.__events.push(e)); });
}
(async () => {
  await fs.mkdir(stage, { recursive: true });
  server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); rounds++;
      check(body.messages.every(m => !('steeringId' in m) && !('steeringStatus' in m)), 'Provider receives no UI-only steering metadata');
      let calls;
      if (rounds === 1) { firstSeen(); await firstGate; calls = [tool('write_file', { path: 'obsolete.md', content: 'must not write' })]; }
      else if (rounds === 2) {
        check(body.messages.some(m => m.role === 'user' && m.content.includes('請改寫 fresh.md')), 'Steer reaches real next model request');
        check(body.messages.some(m => m.role === 'tool' && JSON.parse(m.content).status === 'skipped'), 'Old tool returns skipped without execution');
        secondSeen(); await secondGate;
        calls = [tool('write_file', { path: 'fresh.md', content: '# 已按追加指令修改\n' })];
      } else if (rounds < 21) calls = [tool('inspect_project')];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: calls ? null : '## 已調整方向\n\n依追加指令建立 fresh.md，未執行舊的修改；排版預覽保持原狀。', ...(calls ? { tool_calls: calls } : {}) } }] }));
    } catch (error) { res.statusCode = 500; res.end(error.stack); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const profile = await fs.mkdtemp(path.join(stage, 'profile-')), project = await fs.mkdtemp(path.join(stage, 'project-'));
  await fs.writeFile(path.join(profile, 'ai-settings.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-steer-ui-check', apiMode: 'chat-completions', maxToolRounds: 16 }));
  await launch(profile);
  const info = await call('app.info'); check(info.packaged && info.version === '0.2.3', 'Actual DOConstruct 0.2.3 executable');
  check((await call('ai.settings')).settings.maxToolRounds === 100, 'Packaged app migrates old sixteen-round setting to one hundred');
  await call('project.new', { path: project, options: { kind: 'blank', title: 'Steer 執行中追加指令' } });
  await page.locator('#toggle-ai').click();
  await page.locator('#ai-input').fill('建立 obsolete.md'); await page.locator('#ai-send').click(); await first;
  const id = (await call('ai.history')).activeJob.id;
  check(await page.locator('#ai-send').textContent() === '追加指令', 'Busy task exposes steer action');
  check(await page.locator('#ai-send').isEnabled() && await page.locator('#ai-input').isEditable(), 'Busy task keeps input and send enabled');
  await page.locator('#ai-input').fill('請改寫 fresh.md，原本的 obsolete.md 不要動。'); await page.locator('#ai-send').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.ai-role')].some(e => e.textContent.includes('追加指令 · 等待套用')));
  check(await page.locator('#ai-input').inputValue() === '', 'Accepted steer clears submitted input');
  check((await call('ai.history')).activeJob.id === id, 'Steer stays in same task');
  await page.screenshot({ path: path.join(stage, 'steer-pending.png') });
  releaseFirst(); await second;
  await page.waitForFunction(() => [...document.querySelectorAll('.ai-role')].some(e => e.textContent.includes('追加指令 · 已送入推理')));
  check(await page.locator('#ai-cancel').isVisible(), 'Stop remains available while steered model runs');
  await page.screenshot({ path: path.join(stage, 'steer-applied.png') });
  releaseSecond();
  await page.waitForFunction(id => window.__events.some(e => e.type === 'ai' && e.job.id === id && ['completed', 'failed'].includes(e.job.status)), id, { timeout: 30000 });
  const history = await call('ai.history'); check(history.activeJob.status === 'completed', 'Same task completes after steering');
  check(history.activeJob.round === 21 && rounds === 21, 'Healthy packaged task continues past sixteen rounds');
  check(await fs.readFile(path.join(project, 'fresh.md'), 'utf8') === '# 已按追加指令修改\n', 'New instruction writes real intended file');
  try { await fs.access(path.join(project, 'obsolete.md')); throw Error('Old write ran after steer'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  check(history.activeJob.toolCalls[0].status === 'skipped', 'Old tool recorded as skipped');
  check(!(await call('project.get')).latestPreview, 'Steer never rebuilds document preview');
  await page.waitForFunction(() => document.querySelector('#ai-send').textContent === '發送');
  await page.screenshot({ path: path.join(stage, 'steer-completed.png') });
  await app.close(); app = null; await launch(profile); await call('project.open', { path: project });
  const restored = await call('ai.history');
  check(restored.messages.some(m => m.steeringId && m.steeringStatus === 'applied'), 'Steer status persists across restart');
  await page.locator('#toggle-ai').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.ai-role')].some(e => e.textContent.includes('追加指令 · 已送入推理')));
  check(true, 'Restarted UI shows historical steer status');
  await fs.writeFile(path.join(stage, 'CLOSED.json'), JSON.stringify({ ok: true, checks, rounds, info, note: 'Real app/UI/HTTP/file execution; isolated test profile and project. No live provider, user credentials or original documents used.' }, null, 2));
  await app.close(); app = null; server.closeAllConnections(); await new Promise(r => server.close(r)); console.log('PACKAGED STEER PASS', checks.length);
})().catch(async error => {
  releaseFirst?.(); releaseSecond?.();
  await fs.mkdir(stage, { recursive: true }); await fs.writeFile(path.join(stage, 'CLOSED.json'), JSON.stringify({ ok: false, checks, rounds, error: error.stack }, null, 2));
  try { await page?.screenshot({ path: path.join(stage, 'failure.png') }); } catch {}
  try { await app?.close(); } catch {} server?.closeAllConnections(); server?.close(); console.error(error); process.exitCode = 1;
});
