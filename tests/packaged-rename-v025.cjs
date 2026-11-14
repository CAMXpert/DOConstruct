const { _electron } = require('playwright-core');
const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const root = path.resolve(__dirname, '..'), stage = path.join(root, 'build/release-v025/rename-check');
let app, page, server, requests = 0, release, entered;
const seen = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; }), checks = [];
const check = (ok, name) => { if (!ok) throw Error(name); checks.push(name); };
async function call(method, args = {}) { const r = await page.evaluate(([m, a]) => window.doconstruct.invoke(m, a), [method, args]); if (!r.ok) throw Error(JSON.stringify(r.error)); return r; }
async function launch(profile) {
  app = await _electron.launch({ executablePath: path.join(root, 'dist/win-unpacked/DOConstruct.exe'), args: ['--user-data-dir=' + profile], timeout: 60000 });
  page = await app.firstWindow(); await page.waitForSelector('.cm-editor');
  await page.evaluate(() => { window.__events = []; window.doconstruct.onEvent(e => window.__events.push(e)); });
}
async function done(id) { await page.waitForFunction(id => window.__events.some(e => e.type === 'ai' && e.job.id === id && ['completed', 'failed'].includes(e.job.status)), id, { timeout: 15000 }); const h = await call('ai.history'); check(h.activeJob.status === 'completed', 'Real model task completes'); return h; }
async function rename(title) {
  await page.locator('#ai-rename-session').click(); await page.locator('#ai-session-rename-dialog').waitFor({ state: 'visible' });
  await page.locator('#ai-session-rename-form input[name="title"]').fill(title);
  await page.locator('#ai-session-rename-form [type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#ai-session-rename-dialog').open);
  check(await page.locator('#ai-session option:checked').textContent() === title, 'Dropdown immediately displays the saved title');
}
(async () => {
  await fs.mkdir(stage, { recursive: true });
  const profile = await fs.mkdtemp(path.join(stage, 'profile-')), project = await fs.mkdtemp(path.join(stage, 'project-'));
  server = http.createServer(async (req, res) => { for await (const chunk of req) {} if (++requests === 2) { entered(); await gate; } if (res.destroyed) return; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '# Reply ' + requests } }] })); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); await launch(profile);
  const info = await call('app.info'); check(info.packaged && info.version === '0.2.5', 'Actual DOConstruct 0.2.5 package');
  await call('project.new', { path: project, options: { kind: 'blank', title: 'Rename regression' } });
  await call('ai.configure', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-rename-fixture', apiMode: 'chat-completions' });
  await page.locator('#toggle-ai').click();
  await page.locator('#ai-input').fill('Create a conversation with history.'); await page.locator('#ai-send').click();
  const initialId = (await call('ai.history')).activeJob.id; const original = await done(initialId), sessionId = original.sessionId;
  await rename('人工命名的稿件討論');
  check(JSON.stringify((await call('ai.history')).messages) === JSON.stringify(original.messages), 'Renaming preserves conversation messages');
  check((await call('ai.sessions')).activeSessionId === sessionId, 'Renaming preserves selected session identity');
  // A fresh error must survive the pending three-second success timeout.
  await page.locator('#files-tab').click(); await page.locator('#new-file').click();
  await page.locator('#entry-form input[name="path"]').fill('../must-not-create.md'); await page.locator('#entry-form [type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#notice').hidden && !document.querySelector('#notice').classList.contains('success'));
  await page.locator('#entry-dialog [data-close-dialog]').click();
  await new Promise(r => setTimeout(r, 3300));
  check(await page.evaluate(() => !document.querySelector('#notice').hidden && !document.querySelector('#notice').classList.contains('success')), 'An older success timer never dismisses a later error');
  await page.locator('#dismiss-notice').click();
  await page.locator('#ai-input').fill('Hold this task so I can rename it.'); await page.locator('#ai-send').click(); await seen;
  const active = (await call('ai.history')).activeJob;
  check(active.status === 'running' && await page.locator('#ai-rename-session').isEnabled(), 'Rename is available while AI runs');
  await page.locator('#ai-input').fill('PRESERVE MY UNSENT DRAFT');
  await rename('執行中也可重新命名');
  const after = await call('ai.history');
  check(after.activeJob.id === active.id && after.activeJob.status === 'running', 'Busy rename leaves the same job running');
  check(JSON.stringify(after.messages) === JSON.stringify(active.messages), 'Busy rename does not reload or rewrite chat history');
  check(await page.locator('#ai-input').inputValue() === 'PRESERVE MY UNSENT DRAFT', 'Busy rename preserves the unsent input');
  await page.waitForFunction(() => document.querySelector('#notice').hidden, null, { timeout: 5000 });
  check(true, 'Ordinary success notification disappears automatically');
  await page.screenshot({ path: path.join(stage, 'busy-rename.png') }); release(); await done(active.id);
  const finalMessages = (await call('ai.history')).messages;
  await app.close(); app = null; await launch(profile); await call('project.open', { path: project }); await page.locator('#toggle-ai').click();
  await page.waitForFunction(() => document.querySelector('#ai-session option:checked')?.textContent === '執行中也可重新命名');
  check((await call('ai.sessions')).activeSessionId === sessionId, 'Restart restores the renamed selected session');
  check(JSON.stringify((await call('ai.history')).messages) === JSON.stringify(finalMessages), 'Restart retains all previous messages');
  await fs.writeFile(path.join(stage, 'CLOSED.json'), JSON.stringify({ ok: true, checks, info, modelRequests: requests, note: 'Real packaged UI; isolated temporary workspace/profile and local HTTP fixture. No user files or credentials changed.' }, null, 2));
  await app.close(); app = null; server.closeAllConnections(); await new Promise(r => server.close(r)); console.log('PACKAGED RENAME PASS', checks.length);
})().catch(async error => { release?.(); await fs.mkdir(stage, { recursive: true }); await fs.writeFile(path.join(stage, 'CLOSED.json'), JSON.stringify({ ok: false, checks, error: error.stack }, null, 2)); try { await page?.screenshot({ path: path.join(stage, 'failure.png') }); } catch {} try { await app?.close(); } catch {} server?.closeAllConnections(); server?.close(); console.error(error); process.exitCode = 1; });
