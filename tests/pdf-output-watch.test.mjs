import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DocumentBackend } from '../src/backend/index.mjs';

async function until(check, message) {
  for (let i = 0; i < 160; i++) { const value = await check(); if (value) return value; await delay(20); }
  assert.fail(message);
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doconstruct-pdf-output-')), events = [];
  const backend = new DocumentBackend({ pandocPath: fileURLToPath(new URL('../resources/vendor/pandoc/pandoc.exe', import.meta.url)), onEvent: e => events.push(e) });
  t.after(async () => {
    backend.dispose(); await until(() => !backend.active, 'Backend process did not finish.');
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await backend.createProject(root, { kind: 'blank' }); await backend.listDirectory({ path: '' });
  const changed = (relative, from = 0) => until(() => events.slice(from).find(e => e.type === 'files-changed' && e.paths.includes(relative)), 'Expected watched update for ' + relative);
  return { root, backend, events, changed };
}

test('slow known PDF temporary writes, rename and overwrite refresh the tree without invalidating an active build', async t => {
  const { root, backend, events, changed } = await fixture(t);
  const output = path.join(root, '測試 PDF.pdf'), temporary = output + '.11111111-1111-4111-8111-111111111111.tmp';
  await backend.registerOutput(output); await backend.registerOutput(temporary);
  let release, entered = false;
  const gate = new Promise(r => { release = r; });
  const render = backend.renderer.render.bind(backend.renderer);
  backend.renderer.render = async (...args) => {
    const value = await render(...args); entered = true;
    const stopped = new Promise(resolve => args[2].signal.addEventListener('abort', resolve, { once: true }));
    await Promise.race([gate, stopped]); return value;
  };
  t.after(() => release());
  const call = await backend.build({ runLayoutScript: false });
  await until(() => entered || backend.getJob(call.jobId).finished, 'Build did not enter the renderer.');
  assert.ok(entered, backend.getJob(call.jobId).diagnostics.join('\n'));
  const revision = backend.revision;
  await fs.writeFile(temporary, '%PDF temporary fixture');
  assert.equal((await changed(path.basename(temporary))).sourceChanged, false);
  assert.equal(backend.revision, revision); assert.equal(backend.getJob(call.jobId).status, 'running');
  const mark = events.length; await fs.rename(temporary, output);
  assert.equal((await changed(path.basename(output), mark)).sourceChanged, false);
  assert.equal(backend.revision, revision); assert.equal(backend.getJob(call.jobId).status, 'running');
  const next = events.length; await fs.appendFile(output, '\nsecond export');
  assert.equal((await changed(path.basename(output), next)).sourceChanged, false);
  release(); await until(() => backend.getJob(call.jobId).finished, 'Build did not finish.');
  assert.equal(backend.getJob(call.jobId).status, 'completed');
  assert.equal(backend.revision, revision);
  assert.ok((await backend.listDirectory({ path: '' })).entries.some(e => e.name === path.basename(output)));
});

test('creating a new output directory and slow files inside it does not dirty source revision', async t => {
  const { root, backend, events, changed } = await fixture(t);
  const relative = '輸出 目錄/nested/final.pdf', output = path.join(root, relative), temporary = output + '.11111111-1111-4111-8111-111111111111.tmp';
  const revision = backend.revision;
  await backend.registerOutput(output); await backend.registerOutput(temporary);
  await fs.mkdir(path.dirname(output), { recursive: true });
  assert.equal((await changed('輸出 目錄')).sourceChanged, false);
  await backend.listDirectory({ path: '輸出 目錄/nested' });
  const mark = events.length; await fs.writeFile(temporary, '%PDF fixture');
  assert.equal((await changed(relative + '.11111111-1111-4111-8111-111111111111.tmp', mark)).sourceChanged, false);
  await fs.rename(temporary, output); await changed(relative, mark);
  assert.equal(backend.revision, revision);
});

test('declared source cannot be registered as output and real source or asset updates still invalidate', async t => {
  const { root, backend, events, changed } = await fixture(t);
  for (const relative of ['doconstruct.json', 'layout.py', 'layout.css'])
    await assert.rejects(backend.registerOutput(path.join(root, relative)), e => e.code === 'OUTPUT_INPUT');
  let revision = backend.revision, mark = events.length;
  await fs.appendFile(path.join(root, 'layout.css'), '\n/* a real source change */');
  assert.equal((await changed('layout.css', mark)).sourceChanged, true); assert.ok(backend.revision > revision);
  await fs.writeFile(path.join(root, 'figure.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await changed('figure.svg', mark); await backend.listDirectory({ path: '' });
  revision = backend.revision; mark = events.length;
  await fs.appendFile(path.join(root, 'figure.svg'), '\n<!-- changed asset -->');
  assert.equal((await changed('figure.svg', mark)).sourceChanged, true); assert.ok(backend.revision > revision);
  // A PDF not registered as generated output must retain the previous change semantics.
  revision = backend.revision; mark = events.length;
  await fs.writeFile(path.join(root, 'reference.pdf'), '%PDF reference input');
  assert.equal((await changed('reference.pdf', mark)).sourceChanged, true); assert.ok(backend.revision > revision);
});

test('output registrations end when the project session changes', async t => {
  const { root, backend, events, changed } = await fixture(t);
  const output = path.join(root, 'proof.pdf'); await backend.registerOutput(output);
  await fs.writeFile(output, '%PDF output'); await changed('proof.pdf');
  await backend.createProject(path.join(root, 'other'), { kind: 'blank' });
  await backend.openProject(root); await backend.listDirectory({ path: '' });
  const revision = backend.revision, mark = events.length;
  await fs.appendFile(output, '\nnew session update');
  assert.equal((await changed('proof.pdf', mark)).sourceChanged, true); assert.ok(backend.revision > revision);
});
