import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DocumentBackend } from '../src/backend/index.mjs';

const APP = fileURLToPath(new URL('../', import.meta.url));
const pandocPath = process.env.DOCONSTRUCT_PANDOC || path.join(APP, 'resources/vendor/pandoc/pandoc.exe');
const pythonPath = process.env.DOCONSTRUCT_PYTHON || [path.join(APP, 'resources/vendor/python/python.exe'), path.join(APP, 'resources/vendor/python-embed/python.exe')].find(existsSync);
const terminal = new Set(['completed', 'failed', 'canceled', 'superseded']);

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doconstruct-backend-'));
  const waiters = new Map();
  const backend = new DocumentBackend({ pandocPath, pythonPath, ...options, onEvent: event => {
    const { job } = event;
    if (job && terminal.has(job.status)) waiters.get(job.id)?.(job);
    options.onEvent?.(event);
  } });
  t.after(async () => {
    backend.dispose();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  await backend.createProject(root);
  const wait = async id => {
    const job = backend.getJob(id); if (terminal.has(job.status)) return job;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Task did not terminate in 20 seconds.')), 20000);
      waiters.set(id, result => { clearTimeout(timeout); waiters.delete(id); resolve(result); });
    });
  };
  const build = async (args = { runLayoutScript: false }) => wait((await backend.build(args)).jobId);
  return { root, backend, wait, build };
}

test('atomic editing, new files, external conflicts and project path boundaries', async t => {
  const { root, backend } = await fixture(t);
  const source = await backend.readFile('sections/01-introduction.md');
  await fs.writeFile(path.join(root, source.path), '# external edit\n');
  await assert.rejects(backend.saveFile({ ...source, content: '# editor edit\n' }), e => e.code === 'CONFLICT');
  assert.equal(await fs.readFile(path.join(root, source.path), 'utf8'), '# external edit\n');
  await assert.rejects(backend.readFile('../secret.md'), e => e.code === 'PATH');
  await assert.rejects(backend.readFile(path.resolve(root, 'layout.py')), e => e.code === 'PATH');
  const created = await backend.saveFile({ path: 'sections/new/chapter.md', content: '# Created\n', version: null });
  assert.ok(created.version);
  await assert.rejects(backend.saveFile({ path: created.path, content: 'overwrite', version: null }), e => e.code === 'CONFLICT');
  const dto = await backend.getProject(); assert.ok(dto.files.some(f => f.path === created.path));
  await fs.mkdir(path.join(root, 'data', 'many-nested-files'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'many-nested-files', 'unselected.md'), '# Not editable by discovery\n');
  assert.ok(!(await backend.getProject()).files.some(f => f.path.includes('unselected.md')));
});

test('real Pandoc incremental chapters, CSS and font changes, reorder, latest-only jobs', { skip: !existsSync(pandocPath) }, async t => {
  const { backend, build, wait } = await fixture(t);
  let j = await build(); assert.equal(j.status, 'completed', j.diagnostics.join('\n'));
  assert.equal(j.stats.mode, 'sections'); assert.equal(j.stats.renderedSections, 2); assert.equal(j.stats.cachedSections, 0);
  assert.match(await fs.readFile(j.htmlPath, 'utf8'), /<math /);
  const file = await backend.readFile('sections/01-introduction.md');
  await backend.saveFile({ ...file, content: file.content + '\nOne changed chapter.\n' });
  j = await build(); assert.equal(j.stats.renderedSections, 1); assert.equal(j.stats.cachedSections, 1);
  let p = await backend.getProject(); p.config.style.fontSizePt = 15; p.config.style.marginTopMm = 25;
  await backend.saveConfig({ config: p.config, version: p.version });
  j = await build(); assert.equal(j.stats.renderedSections, 0); assert.equal(j.stats.cachedSections, 2);
  let html = await fs.readFile(j.htmlPath, 'utf8'); assert.match(html, /--body-size:15pt/); assert.match(html, /margin:25mm/);
  p = await backend.getProject(); p.config.sections.reverse();
  await backend.saveConfig({ config: p.config, version: p.version });
  j = await build(); assert.equal(j.stats.renderedSections, 0); assert.equal(j.stats.cachedSections, 2);
  html = await fs.readFile(j.htmlPath, 'utf8'); assert.ok(html.indexOf('data-section-id="details"') < html.indexOf('data-section-id="introduction"'));
  const first = await backend.build({ runLayoutScript: false }); const second = await backend.build({ runLayoutScript: false });
  // A fast cached build may finish while the next request snapshots its files; only live work is superseded.
  assert.ok(['completed', 'superseded'].includes((await wait(first.jobId)).status)); assert.equal((await wait(second.jobId)).status, 'completed');
  assert.equal((await backend.getProject()).latestPreview.jobId, second.jobId);
});

test('global footnotes and cross-file reference definitions preserve full-document semantics', { skip: !existsSync(pandocPath) }, async t => {
  const { root, backend, build } = await fixture(t);
  const imported = path.join(root, 'imported'); await fs.cp(path.join(APP, 'examples/global-notes'), imported, { recursive: true });
  const before = await fs.readFile(path.join(imported, 'assets/introduction/body.md'));
  const p = await backend.openProject(imported); assert.equal(p.config.sections.length, 2);
  let j = await build(); assert.equal(j.status, 'completed', j.diagnostics.join('\n'));
  assert.equal(j.stats.mode, 'global'); assert.match(j.stats.reason, /Footnotes/);
  const html = await fs.readFile(j.htmlPath, 'utf8'); assert.match(html, /class="footnotes/); assert.match(html, /href="https:\/\/pandoc.org\/MANUAL.html"/);
  assert.deepEqual(await fs.readFile(path.join(imported, 'assets/introduction/body.md')), before);
  j = await build(); assert.equal(j.stats.renderedSections, 0); assert.equal(j.stats.cachedSections, 2);
});

test('Python script failure preserves last successful preview; absent Python uses a diagnosed default', { skip: !existsSync(pandocPath) }, async t => {
  const { backend, build } = await fixture(t, { pythonPath: undefined });
  const fallback = await build({ runLayoutScript: true }); assert.equal(fallback.status, 'completed'); assert.match(fallback.diagnostics.join(' '), /Python/);
  if (!pythonPath) return;
  backend.pythonPath = pythonPath;
  const working = await build({ runLayoutScript: true }); assert.equal(working.status, 'completed', working.diagnostics.join('\n'));
  const script = await backend.readFile('layout.py');
  await backend.saveFile({ ...script, content: 'raise RuntimeError("deliberate layout failure")\n' });
  const failed = await build({ runLayoutScript: true }); assert.equal(failed.status, 'failed');
  assert.match(failed.logs.join('\n'), /deliberate layout failure/);
  assert.equal((await backend.getProject()).latestPreview.jobId, working.id);
});

test('explicit argv commands capture output, artifacts and cancellation without a shell', async t => {
  const { backend, wait } = await fixture(t);
  let call = await backend.runCommand({ argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("output with spaces.txt","done"); console.log("command output")'], outputs: ['output with spaces.txt'] });
  let job = await wait(call.jobId); assert.equal(job.status, 'completed'); assert.match(job.logs.join('\n'), /command output/); assert.equal(job.artifacts.length, 1);
  call = await backend.runCommand({ argv: [process.execPath, '-e', 'setTimeout(()=>console.log("late"),10000)'] });
  assert.deepEqual(backend.cancelJob(call.jobId), { canceled: true }); job = await wait(call.jobId); assert.equal(job.status, 'canceled');
});

test('portable executable aliases use supplied runtimes and isolate Node child environment', async t => {
  const { backend, wait } = await fixture(t);
  const parentEnv = process.env.ELECTRON_RUN_AS_NODE;
  let call = await backend.runCommand({ argv: ['{node}', '-e', 'console.log("node-child:"+process.env.ELECTRON_RUN_AS_NODE)'] });
  let job = await wait(call.jobId); assert.equal(job.status, 'completed'); assert.match(job.logs.join('\n'), /node-child:1/);
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, parentEnv);
  if (pythonPath) {
    call = await backend.runCommand({ argv: ['python3', '-c', 'print("portable-python")'] });
    job = await wait(call.jobId); assert.equal(job.status, 'completed'); assert.match(job.logs.join('\n'), /portable-python/);
  }
  if (existsSync(pandocPath)) {
    call = await backend.runCommand({ argv: ['{pandoc}', '--version'] });
    job = await wait(call.jobId); assert.equal(job.status, 'completed'); assert.match(job.logs.join('\n'), /pandoc /);
  }
});

test('declared HTML/PDF outputs become preview artifacts; missing output fails without replacing success', async t => {
  const { backend, wait } = await fixture(t);
  const output = 'require("node:fs").writeFileSync("result.html","<!doctype html><title>Output</title><p>Script result</p>");require("node:fs").writeFileSync("result.pdf","%PDF-1.4\\n%%EOF")';
  let call = await backend.runCommand({ argv: ['{node}', '-e', output], outputs: ['result.html', 'result.pdf'] });
  let job = await wait(call.jobId); assert.equal(job.status, 'completed');
  assert.equal(path.basename(job.htmlPath), 'result.html'); assert.equal(path.basename(job.pdfPath), 'result.pdf');
  assert.equal((await backend.getProject()).latestPreview.jobId, job.id);
  const successfulId = job.id;
  call = await backend.runCommand({ argv: ['{node}', '-e', 'console.error("script diagnostic");console.log("no output")'], outputs: ['not-produced.html'] });
  job = await wait(call.jobId); assert.equal(job.status, 'failed'); assert.match(job.diagnostics.join('\n'), /not-produced.html/);
  assert.match(job.logs.join('\n'), /script diagnostic/);
  assert.equal((await backend.getProject()).latestPreview.jobId, successfulId);
});
