import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DocumentBackend } from '../src/backend/index.mjs';
import { runProcess } from '../src/backend/process.mjs';

async function until(check, message) {
  for (let i = 0; i < 300; i++) { const result = await check(); if (result) return result; await delay(20); }
  assert.fail(message || 'Expected operation to finish.');
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doconstruct-command-'));
  const backend = new DocumentBackend(); const events = [];
  backend.onEvent = event => events.push(event);
  t.after(async () => {
    backend.dispose(); await until(() => !backend.active);
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  });
  await backend.createProject(root, { kind: 'blank' });
  const wait = async id => { await until(() => !backend.active && ['completed', 'failed', 'canceled', 'superseded'].includes(backend.getJob(id).status)); return backend.getJob(id); };
  return { root, backend, wait, events };
}

test('commands without project defaults run in a selected directory and report exit/output', async t => {
  const { root, backend, wait } = await fixture(t);
  await fs.mkdir(path.join(root, 'working directory'));
  const argv = ['{node}', '-e', 'console.log(process.cwd()); console.error("actual stderr"); process.exit(7)'];
  const job = await wait((await backend.runCommand({ argv, cwd: 'working directory', publishPreview: false })).jobId);
  assert.equal(job.status, 'failed'); assert.equal(job.exitCode, 7);
  assert.match(job.stdout, /working directory/); assert.match(job.stderr, /actual stderr/);
  assert.equal(job.cwd, path.join(root, 'working directory'));
  assert.equal(job.argv[0], process.execPath);
  assert.equal(job.error.code, 'PROCESS_FAILED'); assert.equal(job.error.details.exitCode, 7);
  assert.equal((await backend.getProject()).latestPreview, null);
  await assert.rejects(backend.runCommand({ argv: [7] }), e => e.code === 'COMMAND');
});

test('explicit commands do not inherit configured outputs; omitted argv remains compatible', async t => {
  const { backend, wait } = await fixture(t);
  const project = await backend.getProject();
  project.config.command = { argv: ['{node}', '-e', 'require("node:fs").writeFileSync("configured.txt", "configured")'], outputs: ['configured.txt'] };
  await backend.saveConfig(project);
  const own = await wait((await backend.runCommand({ argv: ['{node}', '-e', 'console.log("independent")'], publishPreview: false })).jobId);
  assert.equal(own.status, 'completed'); assert.deepEqual(own.artifacts, []);
  const stored = await wait((await backend.runCommand({ publishPreview: false })).jobId);
  assert.equal(stored.status, 'completed'); assert.equal(stored.artifacts.length, 1);
});

test('command file changes refresh documents without cancelling themselves or updating preview', async t => {
  const { backend, wait, events } = await fixture(t);
  const initial = backend.revision;
  const call = await backend.runCommand({ argv: ['{node}', '-e', 'const fs=require("node:fs");fs.writeFileSync("new.md", "# From command");fs.writeFileSync("output.html", "<html>not a preview</html>");setTimeout(()=>console.log("finished"),350)'], outputs: ['output.html'], publishPreview: false });
  const job = await wait(call.jobId);
  assert.equal(job.status, 'completed', job.diagnostics.join('\n'));
  assert.ok(backend.revision > initial); assert.ok(events.some(e => e.type === 'files-changed' && e.paths.includes('new.md')));
  assert.equal(job.exitCode, 0); assert.match(job.stdout, /finished/);
  assert.equal(job.artifacts.length, 1); assert.equal(job.htmlPath, undefined); assert.equal(job.pdfPath, undefined);
  assert.equal((await backend.getProject()).latestPreview, null);
});

test('switching projects still stops an executing command', async t => {
  const { root, backend, wait } = await fixture(t);
  const call = await backend.runCommand({ argv: ['{node}', '-e', 'console.log("ready"); setInterval(()=>{},100)'], publishPreview: false });
  await until(() => backend.getJob(call.jobId).logs.some(line => line.includes('ready')));
  await backend.createProject(path.join(root, 'other'), { kind: 'blank' });
  const job = await wait(call.jobId); assert.equal(job.status, 'superseded');
  assert.equal((await backend.getProject()).latestPreview, null);
});

test('Windows PowerShell cancellation kills the actual script child', { skip: process.platform !== 'win32' }, async t => {
  const { root } = await fixture(t);
  const childFile = path.join(root, 'child.cjs');
  const pidFile = path.join(root, 'child-pid.txt');
  await fs.writeFile(childFile, 'require("node:fs").writeFileSync(process.argv[2], String(process.pid));setInterval(()=>{},100)');
  const script = `& '${process.execPath.replaceAll("'", "''")}' '${childFile.replaceAll("'", "''")}' '${pidFile.replaceAll("'", "''")}'`;
  const controller = new AbortController();
  const promise = runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { cwd: root, signal: controller.signal });
  t.after(async () => { controller.abort(); await promise.catch(() => {}); });
  const pid = await until(async () => { try { return Number(await fs.readFile(pidFile, 'utf8')); } catch { return false; } }, 'PowerShell script child should start.');
  controller.abort();
  await assert.rejects(promise, e => e.code === 'CANCELED' && e.details.cwd === root);
  await until(() => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }, 'Child process survived cancellation.');
});

test('process timeouts are distinguished from normal nonzero exits', async t => {
  const { root } = await fixture(t);
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("before timeout");setInterval(()=>{},100)'], { cwd: root, timeoutMs: 500 }),
    e => e.code === 'PROCESS_TIMEOUT' && e.details.stdout.includes('before timeout') && e.details.cwd === root);
});
