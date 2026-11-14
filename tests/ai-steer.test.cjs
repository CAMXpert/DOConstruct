const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { AiService } = require('../src/ai/service.cjs');

const assistant = (content, toolCalls) => ({ choices: [{ message: { role: 'assistant', content,
  ...(toolCalls ? { tool_calls: toolCalls } : {}) } }] });
const call = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const responses = output => ({ status: 'completed', output });
const responseText = text => responses([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(get, message) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { const value = await get(); if (value) return value; await delay(10); }
  throw Error(message);
}
function assertPairedCalls(items, responseMode = false) {
  const pending = new Set();
  for (const item of items) {
    if (!responseMode && item.role === 'assistant' && item.tool_calls?.length) {
      assert.equal(pending.size, 0, 'Previous tool call batch must be resolved.');
      for (const c of item.tool_calls) pending.add(c.id);
    } else if (responseMode && item.type === 'function_call') pending.add(item.call_id);
    else if ((!responseMode && item.role === 'tool') || (responseMode && item.type === 'function_call_output')) {
      const id = responseMode ? item.call_id : item.tool_call_id;
      assert.ok(pending.delete(id), `Tool result ${id} must match an outstanding call.`);
    } else if (item.role === 'user' || item.role === 'system') {
      assert.equal(pending.size, 0, 'Steer must not split a tool-call/result batch.');
    }
  }
  assert.equal(pending.size, 0, 'Every requested call must have a result before the next request.');
}
async function fixture(t, handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doconstruct-steer-'));
  const root = path.join(directory, 'document');
  const { DocumentBackend } = await import('../src/backend/index.mjs');
  const events = [], requests = [];
  const backend = new DocumentBackend(); await backend.createProject(root);
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      const reply = await handler(body, requests.length);
      if (reply === undefined || res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply));
    } catch (error) { if (!res.destroyed) { res.writeHead(500); res.end(error.stack); } }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const ai = new AiService({ settingsPath: path.join(directory, 'profile', 'ai-settings.json'), backend,
    onEvent: event => events.push(event) });
  await ai.dispatch('ai.configure', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-steer-fixture' });
  t.after(async () => {
    await ai.dispatch('ai.cancel').catch(() => {}); ai.dispose(); backend.dispose(); server.closeAllConnections();
    await new Promise(r => server.close(r));
    assert.equal(path.dirname(directory), os.tmpdir());
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const wait = async id => {
    await until(() => ai.active?.id === id && ai.active.finished, 'AI steer task did not finalize.');
    return events.filter(e => e.type === 'ai' && e.job.id === id).at(-1).job;
  };
  return { directory, root, ai, backend, events, requests, wait };
}
async function absent(root, file) { await assert.rejects(fs.access(path.join(root, file)), e => e.code === 'ENOENT'); }

test('steer during an API request reaches the same job before stale tool calls can write', async t => {
  const entered = deferred(), release = deferred();
  const instruction = 'Only write redirected.md; never write obsolete.md.';
  const f = await fixture(t, async (body, n) => {
    if (n === 1) { entered.resolve(); await release.promise; return assistant(null, [call('write_file', { path: 'obsolete.md', content: 'wrong' })]); }
    assertPairedCalls(body.messages);
    assert.ok(body.messages.some(m => m.role === 'user' && m.content.includes(instruction)));
    if (n === 2) return assistant(null, [call('write_file', { path: 'redirected.md', content: 'new direction' })]);
    return assistant('Redirected work completed.');
  });
  const id = (await f.ai.dispatch('ai.send', { message: 'write obsolete.md' })).jobId;
  await entered.promise;
  const accepted = await f.ai.dispatch('ai.steer', { id, message: instruction });
  assert.equal(accepted.jobId, id); assert.equal(accepted.queued, true); assert.ok(accepted.instructionId);
  const history = await f.ai.dispatch('ai.history');
  assert.ok(history.messages.some(m => m.role === 'user' && m.content.includes(instruction)), 'Steer must immediately appear in conversation.');
  assert.ok(history.activeJob.steering.some(s => s.id === accepted.instructionId && s.status === 'pending'));
  release.resolve(); const job = await f.wait(id);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(await fs.readFile(path.join(f.root, 'redirected.md'), 'utf8'), 'new direction');
  await absent(f.root, 'obsolete.md');
  assert.ok(job.steering.some(s => s.id === accepted.instructionId && s.status === 'applied'));
  assert.ok(![...f.backend.jobs.values()].some(j => j.kind === 'build'), 'Steer must not trigger document layout.');
});

test('multiple steers and saved-file context are applied in order even after a stale final reply', async t => {
  const entered = deferred(), release = deferred();
  const first = 'Use concise wording.', second = 'Also preserve every experiment number.';
  const f = await fixture(t, async (body, n) => {
    if (n === 1) { entered.resolve(); await release.promise; return assistant('stale unsteered final'); }
    const userMessages = body.messages.filter(m => m.role === 'user');
    assert.ok(userMessages.findIndex(m => m.content.includes(first)) < userMessages.findIndex(m => m.content.includes(second)));
    assert.match(JSON.stringify(body.messages), /SAVED-CONTEXT-237/);
    assertPairedCalls(body.messages); return assistant('Both follow-up instructions applied.');
  });
  await f.backend.saveFile({ path: 'notes.md', content: 'SAVED-CONTEXT-237', version: null });
  const id = (await f.ai.dispatch('ai.send', { message: 'Original long task' })).jobId;
  await entered.promise;
  const a = await f.ai.dispatch('ai.steer', { id, message: first });
  const b = await f.ai.dispatch('ai.steer', { id, message: second, contextPaths: ['notes.md'] });
  release.resolve(); const job = await f.wait(id);
  assert.equal(job.status, 'completed', job.error); assert.equal(f.requests.length, 2, 'A stale final answer must not swallow pending steer.');
  assert.deepEqual(job.steering.map(s => [s.id, s.status]), [[a.instructionId, 'applied'], [b.instructionId, 'applied']]);
  assert.equal(job.messages.at(-1).content, 'Both follow-up instructions applied.');
});

test('steer lets an executing command finish but skips the remaining stale tool batch', async t => {
  const instruction = 'After the running command, write fresh.md instead of stale.md.';
  const f = await fixture(t, (body, n) => {
    if (n === 1) return assistant(null, [call('run_project_command', { argv: ['{node}', '-e',
      'const fs=require("node:fs");fs.writeFileSync("started.txt",String(process.pid));const i=setInterval(()=>{if(fs.existsSync("release.txt")){clearInterval(i);fs.writeFileSync("finished.txt","done");console.log("command finished normally")}},20)'] }, 'running-command'),
      call('write_file', { path: 'stale.md', content: 'must be skipped' }, 'stale-write')]);
    assertPairedCalls(body.messages);
    assert.ok(body.messages.some(m => m.role === 'user' && m.content.includes(instruction)));
    const result = body.messages.find(m => m.role === 'tool' && m.tool_call_id === 'running-command');
    assert.equal(JSON.parse(result.content).status, 'completed', 'An in-flight command must not be killed for normal steer.');
    if (n === 2) return assistant(null, [call('write_file', { path: 'fresh.md', content: 'steered' })]);
    return assistant('Continued with new direction.');
  });
  await f.ai.dispatch('ai.configure', { allowProjectCommands: true });
  const id = (await f.ai.dispatch('ai.send', { message: 'Run the command then write stale.md.' })).jobId;
  await until(async () => { try { return await fs.readFile(path.join(f.root, 'started.txt'), 'utf8'); } catch { return false; } }, 'Command did not actually start.');
  await f.ai.dispatch('ai.steer', { id, message: instruction });
  assert.equal(f.backend.getJob(f.ai.active.commandId).status, 'running');
  await fs.writeFile(path.join(f.root, 'release.txt'), 'continue');
  const job = await f.wait(id); assert.equal(job.status, 'completed', job.error);
  assert.equal(await fs.readFile(path.join(f.root, 'finished.txt'), 'utf8'), 'done');
  assert.equal(await fs.readFile(path.join(f.root, 'fresh.md'), 'utf8'), 'steered');
  await absent(f.root, 'stale.md');
});

test('canceling a task with queued steer never transfers its pending queue into the next task', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async (body, n) => {
    if (n === 1) { entered.resolve(); await release.promise; return assistant('late canceled response'); }
    assert.equal(body.messages.filter(m => m.role === 'user').at(-1).content, 'Start a separate fresh task.');
    return assistant('Fresh task completed.');
  });
  const id = (await f.ai.dispatch('ai.send', { message: 'Original task' })).jobId;
  await entered.promise; await f.ai.dispatch('ai.steer', { id, message: 'Canceled queued direction.' });
  await f.ai.dispatch('ai.cancel', { id }); release.resolve();
  assert.equal((await f.wait(id)).status, 'canceled');
  const next = (await f.ai.dispatch('ai.send', { message: 'Start a separate fresh task.' })).jobId;
  const job = await f.wait(next); assert.equal(job.status, 'completed', job.error);
  assert.deepEqual(job.steering, []);
});

test('steer rejects inactive, stale, invalid-context and changed-project requests without appending them', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async () => { entered.resolve(); await release.promise; return assistant('old project response'); });
  await assert.rejects(f.ai.dispatch('ai.steer', { message: 'No active task.' }));
  const id = (await f.ai.dispatch('ai.send', { message: 'Working in original project.' })).jobId;
  await entered.promise;
  await assert.rejects(f.ai.dispatch('ai.steer', { id: 'wrong-job-id', message: 'Stale task.' }));
  await assert.rejects(f.ai.dispatch('ai.steer', { id, message: '  ' }));
  await assert.rejects(f.ai.dispatch('ai.steer', { id, message: 'Bad file context.', contextPaths: ['../outside.md'] }));
  assert.deepEqual((await f.ai.dispatch('ai.history')).messages.map(m => m.content), ['Working in original project.']);
  await f.backend.createProject(path.join(f.directory, 'next-project'));
  await assert.rejects(f.ai.dispatch('ai.steer', { id, message: 'Wrong project steer.' }));
  release.resolve(); const job = await f.wait(id); assert.ok(['failed', 'canceled'].includes(job.status));
  assert.deepEqual((await f.ai.dispatch('ai.history')).messages, []);
});

test('steer rechecks active job after awaiting file context so a completed task cannot swallow input', async t => {
  const entered = deferred(), release = deferred(), reading = deferred(), readRelease = deferred();
  const f = await fixture(t, async () => { entered.resolve(); await release.promise; return assistant('Original task completed.'); });
  await f.backend.saveFile({ path: 'delayed.md', content: 'saved delayed context', version: null });
  const read = f.backend.readFile.bind(f.backend);
  f.backend.readFile = async p => { if (p === 'delayed.md') { reading.resolve(); await readRelease.promise; } return read(p); };
  const id = (await f.ai.dispatch('ai.send', { message: 'Almost finished.' })).jobId;
  await entered.promise;
  const steered = f.ai.dispatch('ai.steer', { id, message: 'Must not disappear.', contextPaths: ['delayed.md'] });
  // Attach rejection handling now, since the expected error occurs after asynchronous gates.
  const rejected = assert.rejects(steered);
  await reading.promise; release.resolve(); await f.wait(id); readRelease.resolve();
  await rejected;
  assert.ok(!(await f.ai.dispatch('ai.history')).messages.some(m => m.content.includes('Must not disappear.')));
});

test('Responses steering preserves valid function-call output pairing and prevents stale file writes', async t => {
  const entered = deferred(), release = deferred(), instruction = 'Write response-fresh.md instead.';
  const f = await fixture(t, async (body, n) => {
    if (n === 1) {
      entered.resolve(); await release.promise;
      return responses([{ type: 'reasoning', id: 'reason-1', encrypted_content: 'encrypted-test', summary: [] },
        { type: 'function_call', name: 'write_file', arguments: JSON.stringify({ path: 'response-stale.md', content: 'wrong' }), call_id: 'response-stale-call', id: 'call-item-1' }]);
    }
    assertPairedCalls(body.input, true);
    assert.ok(body.input.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes(instruction)));
    if (n === 2) return responses([{ type: 'function_call', name: 'write_file', arguments: JSON.stringify({ path: 'response-fresh.md', content: 'fresh' }), call_id: 'response-fresh-call', id: 'call-item-2' }]);
    return responseText('Responses steer completed.');
  });
  await f.ai.dispatch('ai.configure', { apiMode: 'responses' });
  const id = (await f.ai.dispatch('ai.send', { message: 'Original Responses task.' })).jobId;
  await entered.promise; await f.ai.dispatch('ai.steer', { id, message: instruction });
  release.resolve(); const job = await f.wait(id); assert.equal(job.status, 'completed', job.error);
  assert.equal(await fs.readFile(path.join(f.root, 'response-fresh.md'), 'utf8'), 'fresh');
  await absent(f.root, 'response-stale.md');
});
