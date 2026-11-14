const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { AiService } = require('../src/ai/service.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, handler = () => 'completed') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doconstruct-rename-'));
  const { DocumentBackend } = await import('../src/backend/index.mjs');
  const backend = new DocumentBackend(); await backend.createProject(path.join(directory, 'document'));
  const root = (await backend.getProject()).root, settingsPath = path.join(directory, 'profile', 'ai-settings.json');
  const server = http.createServer(async (req, res) => {
    try { let raw = ''; for await (const chunk of req) raw += chunk;
      const content = await handler(JSON.parse(raw)); if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    } catch (e) { if (!res.destroyed) { res.writeHead(500); res.end(e.message); } }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const services = [], reopen = () => { const ai = new AiService({ backend, settingsPath }); services.push(ai); return ai; }, ai = reopen();
  await ai.dispatch('ai.configure', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-rename-check' });
  t.after(async () => {
    for (const s of services) { await s.dispatch('ai.cancel').catch(() => {}); s.dispose(); }
    backend.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r));
    assert.equal(path.dirname(directory), os.tmpdir()); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const finish = async service => { await service.active.task; return service.history(); };
  return { directory, root, backend, ai, reopen, finish };
}

test('renaming changes only the requested title, persists across reopen and disables automatic naming', async t => {
  const f = await fixture(t), a = (await f.ai.dispatch('ai.sessions')).activeSessionId;
  const b = (await f.ai.dispatch('ai.session.create', { title: 'other session' })).sessionId;
  const before = await f.ai.dispatch('ai.history');
  const renamed = await f.ai.dispatch('ai.session.rename', { id: b, title: '  我的稿件討論  ' });
  assert.deepEqual(renamed, { sessionId: b, title: '我的稿件討論' });
  let sessions = await f.ai.dispatch('ai.sessions'); assert.equal(sessions.activeSessionId, b);
  assert.equal(sessions.sessions.find(s => s.id === b).title, '我的稿件討論');
  assert.equal(sessions.sessions.find(s => s.id === a).title, '新会话');
  assert.deepEqual((await f.ai.dispatch('ai.history')).messages, before.messages);
  await f.ai.dispatch('ai.send', { sessionId: b, message: 'First user task must not overwrite a manual name.' }); await f.finish(f.ai);
  const reopened = f.reopen(); sessions = await reopened.dispatch('ai.sessions');
  assert.equal(sessions.activeSessionId, b); assert.equal(sessions.sessions.find(s => s.id === b).title, '我的稿件討論');
  assert.equal((await reopened.dispatch('ai.history')).messages.length, 2);
});

test('empty, nontext and overlong names are rejected without changing saved titles', async t => {
  const f = await fixture(t), id = (await f.ai.dispatch('ai.sessions')).activeSessionId;
  const before = await f.ai.dispatch('ai.sessions');
  for (const title of ['', ' \n ', 12, null, 'a'.repeat(81)]) await assert.rejects(f.ai.dispatch('ai.session.rename', { id, title }), e => e.code === 'AI_SESSION_TITLE');
  await assert.rejects(f.ai.dispatch('ai.session.rename', { id: 'wrong-id', title: 'valid name' }), e => e.code === 'AI_SESSION');
  assert.deepEqual(await f.ai.dispatch('ai.sessions'), before);
  assert.equal((await f.ai.dispatch('ai.session.rename', { id, title: 'a'.repeat(80) })).title.length, 80);
});

test('a session from a different workspace cannot be renamed', async t => {
  const f = await fixture(t), id = (await f.ai.dispatch('ai.sessions')).activeSessionId;
  await f.backend.createProject(path.join(f.directory, 'other-workspace'));
  const before = await f.ai.dispatch('ai.sessions');
  await assert.rejects(f.ai.dispatch('ai.session.rename', { id, title: 'must not cross workspace' }), e => e.code === 'AI_SESSION');
  assert.deepEqual(await f.ai.dispatch('ai.sessions'), before);
  await f.backend.openProject(f.root); assert.equal((await f.ai.dispatch('ai.sessions')).sessions.find(s => s.id === id).title, '新会话');
});

test('renaming during an active model request preserves job identity, history and steering', async t => {
  const entered = deferred(), release = deferred(); let rounds = 0;
  const f = await fixture(t, async () => { if (++rounds === 1) { entered.resolve(); await release.promise; return 'stale final'; } return 'steered completion'; });
  const id = (await f.ai.dispatch('ai.sessions')).activeSessionId;
  const jobId = (await f.ai.dispatch('ai.send', { sessionId: id, message: 'Long task.' })).jobId; await entered.promise;
  await f.ai.dispatch('ai.session.rename', { id, title: '執行中也能改名' });
  assert.equal(f.ai.active.id, jobId); assert.equal(f.ai.active.controller.signal.aborted, false);
  assert.equal((await f.ai.dispatch('ai.sessions')).activeSessionId, id);
  await f.ai.dispatch('ai.steer', { id: jobId, message: 'Continue with the new instruction.' });
  release.resolve(); const history = await f.finish(f.ai);
  assert.equal(history.activeJob.status, 'completed'); assert.equal(history.activeJob.id, jobId);
  assert.equal(history.messages.at(-1).content, 'steered completion');
  assert.equal((await f.ai.dispatch('ai.sessions')).sessions.find(s => s.id === id).title, '執行中也能改名');
});

test('queued rename rechecks workspace identity before it writes', async t => {
  const f = await fixture(t), id = (await f.ai.dispatch('ai.sessions')).activeSessionId, w = await f.ai.workspace(f.root);
  const gate = deferred(); w.pending = gate.promise;
  const rename = f.ai.dispatch('ai.session.rename', { id, title: 'must not apply after switching' });
  const rejected = assert.rejects(rename, e => e.code === 'AI_PROJECT_CHANGED');
  await new Promise(r => setTimeout(r, 10)); await f.backend.createProject(path.join(f.directory, 'switch-during-rename')); gate.resolve(); await rejected;
  await f.backend.openProject(f.root); assert.equal((await f.ai.dispatch('ai.sessions')).sessions.find(s => s.id === id).title, '新会话');
});
