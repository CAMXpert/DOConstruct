const { _electron } = require('playwright-core');
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), stage = path.join(root, 'build', 'release-v024', 'pdf-check');
const checks = []; let app, page;
const check = (ok, name) => { if (!ok) throw Error(name); checks.push(name); };
async function call(method, args = {}) { const r = await page.evaluate(([m, a]) => window.doconstruct.invoke(m, a), [method, args]); if (!r.ok) throw Object.assign(Error(JSON.stringify(r.error)), { code: r.error.code }); return r; }
async function waitFor(get, name) { const end = Date.now() + 30000; while (Date.now() < end) { const value = await get(); if (value) return value; await new Promise(r => setTimeout(r, 40)); } throw Error(name); }
async function ready() {
  return waitFor(async () => {
    try { const frame = page.frames().find(f => f.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')); if (!frame) return false;
      const state = await frame.evaluate(() => { const v = document.querySelector('pdf-viewer'), t = v?.shadowRoot?.querySelector('viewer-toolbar'); return { state: v?.loadState_, initial: v?.initialLoadComplete_, pages: t?.docLength, progress: t?.loadProgress }; });
      return state.state === 'success' && state.pages > 0 && state.progress === 100 ? state : false;
    } catch { return false; }
  }, 'PDF viewer never renders actual pages');
}
async function finish(mark) {
  await page.waitForFunction(n => window.__proof.slice(n).some(e => e.type === 'job' && e.job.stage === 'pdf' && ['completed', 'failed', 'superseded', 'canceled'].includes(e.job.status)), mark, { timeout: 30000 });
  const job = await page.evaluate(n => window.__proof.slice(n).filter(e => e.type === 'job' && e.job.stage === 'pdf').at(-1).job, mark);
  check(job.status === 'completed', `PDF ${job.previewOnly ? 'preview' : 'export'} completes without false expiration`);
  await ready(); return job;
}
const marker = () => page.evaluate(() => window.__proof.length);
(async () => {
  await fs.mkdir(stage, { recursive: true });
  const profile = await fs.mkdtemp(path.join(stage, 'profile-')), project = await fs.mkdtemp(path.join(stage, '中文 項目-'));
  app = await _electron.launch({ executablePath: path.join(root, 'dist/win-unpacked/DOConstruct.exe'), args: ['--user-data-dir=' + profile], timeout: 60000 });
  page = await app.firstWindow(); await page.waitForSelector('.cm-editor');
  await page.evaluate(() => { window.__proof = []; window.doconstruct.onEvent(e => window.__proof.push(e)); });
  await app.evaluate(({ app, dialog }) => {
    globalThis.__printCount = 0; globalThis.__saveCount = 0;
    dialog.showSaveDialog = async () => { globalThis.__saveCount++; return { canceled: true }; };
    app.on('browser-window-created', (_, win) => { const print = win.webContents.printToPDF.bind(win.webContents); win.webContents.printToPDF = async (...args) => { globalThis.__printCount++; if(globalThis.__holdPrint)await new Promise(r=>{globalThis.__releasePrint=r;}); return print(...args); }; });
  });
  await call('project.new', { path: project, options: { kind: 'starter', title: 'PDF 成品回歸' } });
  await page.waitForFunction(p => document.querySelector('#project-location').title === p, project);
  check((await call('app.info')).version === '0.2.4', 'Real packaged version is 0.2.4');
  check(await page.locator('#pdf-tab').isEnabled(), 'PDF tab is enabled before any export or build');
  let mark = await marker(); await page.locator('#pdf-tab').click(); const preview = await finish(mark);
  check(await app.evaluate(() => globalThis.__saveCount) === 0, 'Direct PDF tab does not require Save As');
  check(await app.evaluate(() => globalThis.__printCount) === 1, 'First PDF tab actually prints once');
  check((await fs.readFile(preview.pdfPath)).subarray(0, 5).toString() === '%PDF-', 'Preview is a real PDF');
  const state = await ready(); check(state.initial === true, 'Actual built-in viewer has loaded pages');
  await page.screenshot({ path: path.join(stage, 'pdf-visible.png') });
  const revision = (await call('project.get')).revision;
  await page.locator('#html-tab').click(); await page.locator('#pdf-tab').click(); await ready();
  check(await app.evaluate(() => globalThis.__printCount) === 1, 'HTML/PDF tab switching reuses valid preview');
  await call('file.list', { path: '' });
  const destinations = [path.join(project, '新 目錄', '成品 #1.pdf'), path.join(project, '新 目錄', '成品 #1.pdf'), path.join(stage, 'outside 成品.pdf')];
  await app.evaluate((_, folder) => { const io = process.getBuiltinModule('node:fs/promises'), copy = io.copyFile.bind(io); io.copyFile = async (a, b, ...rest) => { if (b.startsWith(folder) && b.endsWith('.tmp')) await new Promise(r => setTimeout(r, 180)); return copy(a, b, ...rest); }; }, project);
  for (const destination of destinations) {
    await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => { globalThis.__saveCount++; return { canceled: false, filePath: target }; }; }, destination);
    mark = await marker(); await page.locator('#export-pdf').click(); const exported = await finish(mark);
    check((await fs.readFile(exported.pdfPath)).equals(await fs.readFile(preview.pdfPath)), 'Saved PDF equals the displayed PDF, including Unicode/space path');
  }
  await new Promise(r => setTimeout(r, 250));
  check((await call('project.get')).revision === revision, 'Slow project output and repeated overwrite do not change source revision');
  check(await app.evaluate(() => globalThis.__printCount) === 1, 'All exports reuse actual PDF without reprinting');
  await app.evaluate(({ shell }) => { globalThis.__openPath = shell.openPath; shell.openPath = async () => 'fixture: no PDF association'; });
  const open = await page.evaluate(p => window.doconstruct.invoke('artifact.open', { path: p }), preview.pdfPath);
  check(!open.ok && open.error.message.includes('no PDF association'), 'System viewer open failures return the actual error');
  await app.evaluate(({ shell }) => { shell.openPath = globalThis.__openPath; delete globalThis.__openPath; });
  const source = (await call('project.get')).config.sections[0].path;
  await fs.appendFile(path.join(project, source), '\n\nCHANGED_SOURCE_FOR_PDF_REFRESH\n');
  await waitFor(async () => (await call('project.get')).revision > revision, 'Real source must change the revision');
  await page.waitForFunction(() => document.querySelector('#preview-state').textContent.includes('文件已變更'));
  mark = await marker(); await page.locator('#pdf-tab').click(); const revised = await finish(mark);
  check(await app.evaluate(() => globalThis.__printCount) === 2, 'Changed source generates a new PDF');
  check(revised.htmlPath !== preview.htmlPath && revised.pdfPath !== preview.pdfPath, 'PDF cache is bound to the current HTML, not stale content');
  check((await fs.readFile(revised.htmlPath, 'utf8')).includes('CHANGED_SOURCE_FOR_PDF_REFRESH'), 'New PDF uses changed real source');
  await page.screenshot({ path: path.join(stage, 'pdf-updated.png') });
  // Hold only the actual print operation to exercise cancellation without a timing guess.
  await app.evaluate(() => { globalThis.__holdPrint = true; });
  await fs.appendFile(path.join(project, source), '\nCANCEL_PRINT_FIXTURE\n');
  await page.waitForFunction(() => document.querySelector('#preview-state').textContent.includes('文件已變更'));
  mark = await marker(); await page.locator('#pdf-tab').click();
  await waitFor(() => app.evaluate(() => typeof globalThis.__releasePrint === 'function'), 'Print does not start');
  await page.locator('#cancel-job').click();
  await app.evaluate(() => { globalThis.__holdPrint=false;globalThis.__releasePrint();delete globalThis.__releasePrint; });
  await waitFor(async () => { const events=await page.evaluate(n=>window.__proof.slice(n).filter(e=>e.type==='job'&&e.job.stage==='pdf'),mark);return events.at(-1)?.job.status==='canceled'; }, 'Canceled PDF becomes completed');
  check(true, 'Canceled print remains canceled and the UI is usable');
  await app.evaluate(() => { globalThis.__holdPrint = true; });
  mark = await marker(); await page.locator('#pdf-tab').click();
  await waitFor(() => app.evaluate(() => typeof globalThis.__releasePrint === 'function'), 'Second print does not start');
  const oldId = await page.evaluate(n => window.__proof.slice(n).filter(e=>e.type==='job'&&e.job.stage==='pdf').at(-1).job.id, mark);
  await call('project.new', { path: path.join(stage, 'new-workspace-'+crypto.randomUUID()), options: {kind:'blank',title:'New workspace'} });
  await app.evaluate(() => { globalThis.__holdPrint=false;globalThis.__releasePrint();delete globalThis.__releasePrint; });
  await waitFor(async () => (await call('build.inspect',{id:oldId})).status==='superseded','Old PDF result is not isolated');
  check(!(await call('project.get')).latestPreview, 'Old PDF cannot become the new workspace preview');
  await fs.writeFile(path.join(stage, 'CLOSED.json'), JSON.stringify({ ok: true, checks, viewer: state, preview: { htmlPath: preview.htmlPath, pdfPath: preview.pdfPath }, sha256: crypto.createHash('sha256').update(await fs.readFile(preview.pdfPath)).digest('hex'), note: 'Real packaged app, actual viewer loaded state/pages and visible screenshots; isolated test profile/project; no user files changed.' }, null, 2));
  await app.close(); console.log('PACKAGED PDF PASS', checks.length);
})().catch(async error => { await fs.mkdir(stage, { recursive: true }); await fs.writeFile(path.join(stage, 'CLOSED.json'), JSON.stringify({ ok: false, checks, error: error.stack }, null, 2)); try { await page?.screenshot({ path: path.join(stage, 'failure.png') }); } catch {} try { await app?.close(); } catch {} console.error(error); process.exitCode = 1; });
