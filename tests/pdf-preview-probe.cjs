const { _electron } = require('playwright-core');
const fs = require('node:fs/promises'), path = require('node:path');
const root = path.resolve(__dirname, '..'), stage = path.join(root, 'build', 'pdf-preview-fix', process.env.PDF_PROBE_RUN || 'before');
let app, page; const errors = [];
const call = async (method, args = {}) => { const r = await page.evaluate(([m, a]) => window.doconstruct.invoke(m, a), [method, args]); if (!r.ok) throw Error(JSON.stringify(r.error)); return r; };
const waitJob = async id => { for (let i = 0; i < 300; i++) { const j = await call('build.inspect', { id }); if (['completed', 'failed', 'canceled', 'superseded'].includes(j.status)) { if (j.status !== 'completed') throw Error(JSON.stringify(j)); return j; } await new Promise(r => setTimeout(r, 100)); } throw Error('Job timeout'); };
(async () => {
  await fs.mkdir(stage, { recursive: true });
  app = await _electron.launch({ executablePath: path.join(root, 'dist', 'win-unpacked', 'DOConstruct.exe'), args: ['--user-data-dir=' + path.join(stage, 'profile')], timeout: 60000 });
  page = await app.firstWindow(); await page.waitForSelector('.cm-editor');
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', e => errors.push(e.stack));
  page.on('requestfailed', request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
  await call('project.new', { path: path.join(stage, '中文 有空格'), options: { kind: 'paper', title: 'PDF 成品測試' } });
  const started = await call('build.start'); const build = await waitJob(started.jobId);
  const pdfPath = path.join(stage, '中文 成品 #1.pdf');
  await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, pdfPath);
  // Real toolbar export uses the completed HTML through normal renderer state.
  await page.locator('#build').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent.startsWith('完成'));
  await page.locator('#export-pdf').click();
  await page.waitForFunction(() => document.querySelector('#pdf-tab').classList.contains('selected'), null, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1800));
  const frames = [];
  for (const frame of page.frames()) {
    try { frames.push({ url: frame.url(), body: (await frame.locator('body').innerText()).slice(0, 1800), html: (await frame.locator('body').innerHTML()).slice(0, 4000) }); }
    catch (e) { frames.push({ url: frame.url(), error: e.message }); }
  }
  await page.screenshot({ path: path.join(stage, 'pdf.png') });
  const bytes = await fs.readFile(pdfPath);
  const report = { ok: true, pdfPath, pdfBytes: bytes.length, header: bytes.subarray(0, 5).toString(), errors, frames };
  await fs.writeFile(path.join(stage, 'REPORT.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pdfPath, pdfBytes: report.pdfBytes, header: report.header, errors, frames: frames.map(({ url, body, error }) => ({ url, body, error })) }));
  await app.close();
})().catch(async e => { console.error(e); try { await page?.screenshot({ path: path.join(stage, 'failure.png') }); } catch {} try { await app?.close(); } catch {} process.exitCode = 1; });
