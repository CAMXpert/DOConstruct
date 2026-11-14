const { _electron } = require('playwright-core');
const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), stage = path.join(root, 'build/release-v023/chat-check');
const checks = [], requests = []; let app, page, server, release, firstSeen, clipboardSnapshot;
const first = new Promise(r => { firstSeen = r; }), gate = new Promise(r => { release = r; });
const answer = '# Local reply\n\n**Markdown** remains readable.\n\n```js\nconst example = 23;\n```\n';
const check = (ok, name) => { if (!ok) throw Error(name); checks.push(name); };
async function call(method, args = {}) {
  const value = await page.evaluate(([m, a]) => window.doconstruct.invoke(m, a), [method, args]);
  if (!value.ok) throw Error(JSON.stringify(value.error)); return value;
}
async function launch(profile) {
  app = await _electron.launch({ executablePath: path.join(root, 'dist/win-unpacked/DOConstruct.exe'), args: ['--user-data-dir=' + profile], timeout: 60000 });
  page = await app.firstWindow(); await page.waitForSelector('.cm-editor');
  await page.evaluate(() => { window.__events = []; window.doconstruct.onEvent(e => window.__events.push(e)); });
}
const eventMark = () => page.evaluate(() => window.__events.length);
async function completedAfter(mark) {
  await page.waitForFunction(n => window.__events.slice(n).some(e => e.type === 'ai' && ['completed', 'failed'].includes(e.job.status)), mark, { timeout: 30000 });
  const history = await call('ai.history'); check(history.activeJob.status === 'completed', 'Actual model task completes'); return history;
}
async function openWorkspace(folder) {
  await call('project.open', { path: folder });
  await page.waitForFunction(p => document.querySelector('#project-location').title === p, folder);
}
async function workspace(folder, title) {
  await fs.mkdir(path.join(folder, 'content'), { recursive: true });
  await fs.writeFile(path.join(folder, 'doconstruct.json'), JSON.stringify({ version: 1, title, sections: [], layoutScript: '', stylesheet: '' }));
  await fs.writeFile(path.join(folder, 'content/allowed.md'), '# Allowed source\n');
}
async function anchor() {
  return page.evaluate(() => { const box = document.querySelector('#ai-messages'), bounds = box.getBoundingClientRect();
    const row = [...box.querySelectorAll('.ai-message')].find(e => e.getBoundingClientRect().bottom > bounds.top + 2);
    return { index: row?.dataset.messageIndex, top: row?.getBoundingClientRect().top - bounds.top, scrollTop: box.scrollTop }; });
}
async function restoreClipboard() {
  if (!app || !clipboardSnapshot) return;
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    const values = await Promise.all(globalThis.__originalTestClipboard.map(async item => {
      const formats = {}; for (const type of item.types) formats[type] = await item.getType(type);
      return new ClipboardItem(formats);
    }));
    if (values.length) await clipboard.write(values); else clipboard.clear();
    delete globalThis.__originalTestClipboard;
  });
  clipboardSnapshot = null;
}
(async () => {
  await fs.mkdir(stage, { recursive: true });
  const profile = await fs.mkdtemp(path.join(stage, 'profile-')), project = await fs.mkdtemp(path.join(stage, 'workspace-a-')), other = await fs.mkdtemp(path.join(stage, 'workspace-b-'));
  await workspace(project, 'Long chat A'); await workspace(other, 'Independent B');
  const legacy = Array.from({ length: 257 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Legacy message ${i}\n\nParagraph ${i} keeps the history scrollable.\n\nSecond paragraph ${i}.` }));
  const legacyFile = path.join(profile, 'ai-history', crypto.createHash('sha256').update(project).digest('hex') + '.json');
  await fs.mkdir(path.dirname(legacyFile), { recursive: true });
  const legacyBytes = JSON.stringify({ root: project, messages: legacy, tasks: [] }); await fs.writeFile(legacyFile, legacyBytes);
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; requests.push(JSON.parse(raw));
    if (requests.length === 1) { firstSeen(); await gate; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  await fs.writeFile(path.join(profile, 'ai-settings.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-chat-check', apiMode: 'chat-completions' }));
  await launch(profile); const info = await call('app.info'); check(info.packaged && info.version === '0.2.3', 'Actual packaged DOConstruct 0.2.3');
  console.log('Actual clipboard methods', await app.evaluate(({ clipboard }) => Object.fromEntries(['read','readText','write','writeText','readHTML'].map(k => [k, typeof clipboard[k]]))));
  await page.locator('#toggle-ai').click(); await page.locator('#ai-settings-button').click();
  check(await page.locator('[name="allowProjectCommands"]').isDisabled(), 'No-workspace command checkbox cannot imply a global grant');
  await page.locator('#ai-settings-dialog [data-close-dialog]').click();
  await openWorkspace(project); await page.waitForFunction(() => document.querySelector('#ai-history-state').textContent.includes('/ 257'));
  let history = await call('ai.history'), originalSession = history.sessionId;
  check(history.messages.length === 100 && history.firstIndex === 157 && history.totalMessages === 257, '257 legacy messages migrate; default page is the latest 100');
  check(await page.locator('#ai-messages .ai-message').count() === 100, 'Only one hundred message nodes initially rendered');
  await page.locator('#ai-messages').evaluate(e => { e.scrollTop = 0; }); const before = await anchor();
  await page.locator('#ai-load-earlier').click(); await page.waitForFunction(() => document.querySelectorAll('#ai-messages .ai-message').length === 200);
  const after = await anchor(); check(after.index === before.index && Math.abs(after.top - before.top) < 3, 'Prepending earlier messages preserves the visible anchor');
  const mark = await eventMark(); await call('ai.send', { message: 'Background request while reading old messages', sessionId: originalSession }); await first;
  const pending = await anchor(); check(pending.index === after.index && Math.abs(pending.top - after.top) < 3, 'Running-task events do not pull an older page to the bottom');
  check(await page.locator('#ai-latest').isVisible(), 'Reading old messages exposes Return to latest');
  check(await page.locator('#ai-session').isDisabled() && await page.locator('#ai-new-session').isDisabled(), 'Session controls stay locked while a task runs');
  release(); await completedAfter(mark); const finishedAnchor = await anchor();
  check(finishedAnchor.index === after.index && Math.abs(finishedAnchor.top - after.top) < 3, 'Task completion preserves the old reading position');
  await page.locator('#ai-latest').click(); await page.waitForFunction(() => document.querySelectorAll('#ai-messages .ai-message').length === 100 && document.querySelector('#ai-latest').hidden);
  check(await page.locator('#ai-messages').evaluate(e => e.scrollTop + e.clientHeight >= e.scrollHeight - 3), 'Return to latest restores bottom following');
  await app.evaluate(async ({ clipboard }) => { globalThis.__originalTestClipboard = await clipboard.read(); }); clipboardSnapshot = true;
  await page.locator('#ai-messages .assistant').last().locator('[data-ai-action="copy"]').click();
  await page.waitForFunction(() => document.querySelector('#notice-text').textContent === '已複製訊息原文。');
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  check(copied.replaceAll('\r\n','\n') === answer, 'Message Copy copies original Markdown (Windows newline normalization)');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('Exercise native fallback'); } } }));
  await page.locator('#ai-messages .assistant').last().locator('[data-ai-action="copy-code"]').click();
  await page.waitForFunction(() => document.querySelector('#notice-text').textContent === '已複製程式碼。');
  check((await app.evaluate(({ clipboard }) => clipboard.readText())).replaceAll('\r\n','\n') === 'const example = 23;\n', 'Code Copy and native clipboard fallback copy code only');
  await restoreClipboard();
  await page.locator('#ai-messages .user').last().locator('[data-ai-action="edit"]').click();
  check(await page.locator('#ai-input').inputValue() === 'Background request while reading old messages', 'Edit returns source text to the input');
  check((await call('ai.history')).totalMessages === 259, 'Editing a message does not remove history or rerun work');
  await page.locator('#ai-input').fill(''); const retryMark = await eventMark();
  await page.locator('#ai-messages .assistant').last().locator('[data-ai-action="retry"]').click(); await completedAfter(retryMark);
  check((await call('ai.history')).totalMessages === 261, 'Retry appends a new task instead of rewriting history');
  await page.locator('#ai-new-session').click(); await page.waitForFunction(id => document.querySelector('#ai-session').value !== id && document.querySelector('#ai-session').options.length === 2 && document.querySelectorAll('#ai-messages .ai-message').length === 0, originalSession);
  const secondSession = (await call('ai.history')).sessionId; check(secondSession !== originalSession, 'New session has its own empty history');
  const countBeforeKeys = requests.length;
  await page.locator('#ai-input').fill('Session B only'); await page.locator('#ai-input').press('Shift+Enter');
  check((await page.locator('#ai-input').inputValue()).endsWith('\n') && requests.length === countBeforeKeys, 'Shift+Enter inserts a newline without sending');
  await page.locator('#ai-input').evaluate(e => { e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })); });
  check((await call('ai.history')).totalMessages === 0, 'IME composition Enter never submits a task');
  const enterMark = await eventMark(); await page.locator('#ai-input').press('Enter'); await completedAfter(enterMark);
  check((await call('ai.history')).totalMessages === 2, 'Enter sends through the normal task path');
  await page.waitForFunction(() => document.querySelector('#ai-session').selectedOptions[0].textContent.includes('Session B only'));
  check(true, 'Session title follows its first task');
  await page.locator('#ai-session').selectOption(originalSession); await page.waitForFunction(() => document.querySelector('#ai-history-state').textContent.includes('/ 261'));
  check((await call('ai.history')).sessionId === originalSession, 'Selecting the original session restores its own history');
  await page.locator('#ai-session').selectOption(secondSession); await page.waitForFunction(() => document.querySelector('#ai-history-state').textContent.includes('/ 2'));
  await openWorkspace(other); await page.waitForFunction(() => document.querySelector('#ai-session').options.length === 1 && document.querySelectorAll('#ai-messages .ai-message').length === 0);
  check((await call('ai.history')).totalMessages === 0, 'Another workspace starts with independent conversations');
  await openWorkspace(project); await page.waitForFunction(id => document.querySelector('#ai-session').value === id && document.querySelector('#ai-history-state').textContent.includes('/ 2'), secondSession);
  check((await call('ai.history')).sessionId === secondSession, 'Returning to a workspace restores its selected conversation');
  await page.locator('#ai-settings-button').click(); const form = page.locator('#ai-settings-form');
  await form.locator('[name="readFiles"]').check(); await form.locator('[name="writeFiles"]').uncheck(); await form.locator('[name="allowedPaths"]').fill('content'); await form.locator('[name="allowProjectCommands"]').uncheck();
  await form.locator('button[type="submit"]').click(); await page.waitForFunction(() => !document.querySelector('#ai-settings-dialog').open);
  const permissions = (await call('ai.permissions')).permissions;
  check(permissions.readFiles && !permissions.writeFiles && !permissions.allowCommands && permissions.allowedPaths.join(',') === 'content', 'UI saves read-only content-scoped permissions');
  await page.locator('#ai-settings-button').click();
  check(await form.locator('[name="allowedPaths"]').inputValue() === 'content' && !(await form.locator('[name="writeFiles"]').isChecked()), 'Permission settings reopen with their saved scope');
  await form.locator('[name="allowProjectCommands"]').check(); await form.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#notice-text').textContent.includes('执行命令需要'));
  check(await page.locator('#ai-settings-dialog').evaluate(e => e.open) && !(await call('ai.permissions')).permissions.allowCommands, 'Read-only scoped shell grant is rejected without broadening permissions');
  check((await form.locator('#ai-command-permission-note').textContent()).includes('無法由文件範圍隔離'), 'Command UI explains native commands are not a file sandbox');
  await page.locator('#ai-settings-dialog [data-close-dialog]').click();
  await page.screenshot({ path: path.join(stage, 'chat-workbench.png') });
  await app.close(); app = null; await launch(profile); await openWorkspace(project); await page.locator('#toggle-ai').click();
  await page.waitForFunction(id => document.querySelector('#ai-session').value === id, secondSession);
  check((await call('ai.history')).sessionId === secondSession, 'Selected session survives an actual application restart');
  check((await call('ai.permissions')).permissions.allowedPaths.join(',') === 'content', 'Workspace permission scope survives restart');
  check(await fs.readFile(legacyFile, 'utf8') === legacyBytes, 'Legacy source history remains unchanged');
  await fs.writeFile(path.join(stage, 'CLOSED.json'), JSON.stringify({ ok: true, checks, info, modelRequests: requests.length, note: 'Real packaged UI; isolated profiles/workspaces; local HTTP fixture. Clipboard restored, no original user files or credentials modified.' }, null, 2));
  await app.close(); app = null; server.closeAllConnections(); await new Promise(r => server.close(r)); console.log('PACKAGED CHAT PASS', checks.length);
})().catch(async error => {
  release?.(); await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, 'CLOSED.json'), JSON.stringify({ ok: false, checks, modelRequests: requests.length, error: error.stack }, null, 2));
  try { await restoreClipboard(); } catch {} try { await page?.screenshot({ path: path.join(stage, 'failure.png') }); } catch {}
  try { await app?.close(); } catch {} server?.closeAllConnections(); server?.close(); console.error(error); process.exitCode = 1;
});
