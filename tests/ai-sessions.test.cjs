const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { AiService } = require('../src/ai/service.cjs');

const digest = s => crypto.createHash('sha256').update(s).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const reply = (content, tools) => ({ choices: [{ message: { role: 'assistant', content, ...(tools ? { tool_calls: tools } : {}) } }] });
const call = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function fixture(t, handler = () => reply('done'), prepare) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doconstruct-sessions-'));
  const { DocumentBackend } = await import('../src/backend/index.mjs');
  const backend = new DocumentBackend(); await backend.createProject(path.join(directory, 'document'));
  const root = (await backend.getProject()).root;
  const settingsPath = path.join(directory, 'profile', 'ai-settings.json');
  const legacyFile = path.join(path.dirname(settingsPath), 'ai-history', digest(root) + '.json');
  const events = [], requests = [], services = [];
  if (prepare) await prepare({ directory, root, backend, legacyFile });
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      const result = await handler(body, requests.length);
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) { if (!res.destroyed) { res.writeHead(500); res.end(error.stack); } }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const reopen = () => {
    const ai = new AiService({ settingsPath, backend, onEvent: e => events.push(e) }); services.push(ai); return ai;
  };
  const ai = reopen();
  await ai.dispatch('ai.configure', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-sessions-fixture' });
  t.after(async () => {
    for (const service of services) { await service.dispatch('ai.cancel').catch(() => {}); service.dispose(); }
    backend.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r));
    assert.equal(path.dirname(directory), os.tmpdir());
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const wait = async (service, id) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (service.active?.id === id && service.active.finished) return events.filter(e => e.type === 'ai' && e.job.id === id).at(-1).job;
      await new Promise(r => setTimeout(r, 10));
    }
    throw Error('Session task did not finalize.');
  };
  const run = async (service, message) => wait(service, (await service.dispatch('ai.send', { message })).jobId);
  return { directory, root, backend, ai, events, requests, reopen, legacyFile, wait, run };
}
async function writeLegacy(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }

test('legacy workspace history imports into a default chat without deleting or rewriting the old record', async t => {
  const messages = [{ role: 'user', content: 'Legacy request.' }, { role: 'assistant', content: 'Legacy response.' }];
  const before = '# original', after = '# legacy after';
  const f = await fixture(t, undefined, async ({ root, backend, legacyFile }) => {
    await backend.saveFile({ path: 'legacy.md', content: after, version: null });
    await writeLegacy(legacyFile, { root, messages, tasks: [{ id: 'legacy-task', root, status: 'completed', undone: false,
      changes: [{ path: 'legacy.md', before, after, afterVersion: digest(after) }] }] });
  });
  const original = await fs.readFile(f.legacyFile);
  const sessions = await f.ai.dispatch('ai.sessions');
  assert.equal(sessions.sessions.length, 1); assert.ok(sessions.activeSessionId);
  const history = await f.ai.dispatch('ai.history');
  assert.equal(history.sessionId, sessions.activeSessionId); assert.deepEqual(history.messages, messages);
  assert.equal(history.changeTasks[0].id, 'legacy-task');
  assert.equal((await f.ai.dispatch('ai.changes', { id: 'legacy-task', path: 'legacy.md' })).before, before);
  const reopened = f.reopen();
  assert.equal((await reopened.dispatch('ai.sessions')).activeSessionId, history.sessionId);
  assert.deepEqual((await reopened.dispatch('ai.history')).messages, messages);
  assert.deepEqual(await fs.readFile(f.legacyFile), original, 'Legacy source must remain byte-for-byte intact after import and reopen.');
});

test('each workspace retains its own chats and active selection, and cannot select another workspace chat', async t => {
  const f = await fixture(t, body => reply('Completed: ' + body.messages.filter(m => m.role === 'user').at(-1).content));
  const aDefault = (await f.ai.dispatch('ai.sessions')).activeSessionId;
  const aExtra = (await f.ai.dispatch('ai.session.create', { title: 'Workspace A extra' })).sessionId;
  assert.notEqual(aExtra, aDefault);
  await f.run(f.ai, 'workspace A only');
  const bRoot = path.join(f.directory, 'workspace-b'); await f.backend.createProject(bRoot);
  const bDefault = (await f.ai.dispatch('ai.sessions')).activeSessionId;
  assert.notEqual(bDefault, aDefault);
  const bExtra = (await f.ai.dispatch('ai.session.create', { title: 'Workspace B extra' })).sessionId;
  await f.ai.dispatch('ai.session.select', { id: bDefault });
  await f.run(f.ai, 'workspace B only');
  await assert.rejects(f.ai.dispatch('ai.session.select', { id: aExtra }));
  assert.equal((await f.ai.dispatch('ai.sessions')).activeSessionId, bDefault);
  await f.backend.openProject(f.root);
  assert.equal((await f.ai.dispatch('ai.sessions')).activeSessionId, aExtra);
  const aHistory = await f.ai.dispatch('ai.history');
  assert.ok(aHistory.messages.some(m => m.content.includes('workspace A only')));
  assert.ok(!aHistory.messages.some(m => m.content.includes('workspace B only')));
  const reopened = f.reopen();
  assert.equal((await reopened.dispatch('ai.sessions')).activeSessionId, aExtra);
  await f.backend.openProject(bRoot);
  const bSessions = await reopened.dispatch('ai.sessions');
  assert.equal(bSessions.activeSessionId, bDefault);
  assert.ok(bSessions.sessions.some(s => s.id === bExtra && s.title === 'Workspace B extra'));
  assert.ok(!(await reopened.dispatch('ai.history')).messages.some(m => m.content.includes('workspace A only')));
});

test('same-workspace chat history, diff and undo are isolated and active selection survives restart', async t => {
  const rounds = new Map();
  const f = await fixture(t, body => {
    const marker = body.messages.filter(m => m.role === 'user').at(-1).content;
    const n = (rounds.get(marker) || 0) + 1; rounds.set(marker, n);
    const file = marker === 'Edit in chat A.' ? 'a.md' : 'b.md';
    if (n === 1) return reply(null, [call('read_file', { path: file })]);
    if (n === 2) return reply(null, [call('write_file', { path: file, content: 'after-' + file })]);
    return reply('Finished ' + marker);
  });
  await f.backend.saveFile({ path: 'a.md', content: 'before-a', version: null });
  await f.backend.saveFile({ path: 'b.md', content: 'before-b', version: null });
  const a = (await f.ai.dispatch('ai.sessions')).activeSessionId;
  const aJob = await f.run(f.ai, 'Edit in chat A.'); assert.equal(aJob.status, 'completed', aJob.error); assert.equal(aJob.sessionId, a);
  const b = (await f.ai.dispatch('ai.session.create', { title: 'Independent chat B' })).sessionId;
  const empty = await f.ai.dispatch('ai.history');
  assert.equal(empty.sessionId, b); assert.deepEqual(empty.messages, []); assert.deepEqual(empty.changeTasks, []);
  assert.ok(!empty.activeJob, 'A completed job from chat A must not appear inside chat B.');
  await assert.rejects(f.ai.dispatch('ai.changes', { id: aJob.id, path: 'a.md' }));
  const bJob = await f.run(f.ai, 'Edit in chat B.'); assert.equal(bJob.status, 'completed', bJob.error);
  assert.equal(bJob.sessionId, b); assert.equal((await f.ai.dispatch('ai.changes')).tasks[0].id, bJob.id);
  await f.ai.dispatch('ai.session.select', { id: a });
  assert.deepEqual((await f.ai.dispatch('ai.changes')).tasks.map(t => t.id), [aJob.id]);
  assert.ok(!(await f.ai.dispatch('ai.history')).messages.some(m => m.content.includes('chat B')));
  assert.equal((await f.ai.dispatch('ai.undo')).restoredCount, 1);
  assert.equal((await f.backend.readFile('a.md')).content, 'before-a');
  assert.equal((await f.backend.readFile('b.md')).content, 'after-b.md', 'Undo in A must preserve B edits.');
  await f.ai.dispatch('ai.session.select', { id: b });
  const reopened = f.reopen(); assert.equal((await reopened.dispatch('ai.sessions')).activeSessionId, b);
  assert.equal((await reopened.dispatch('ai.history')).changeTasks[0].id, bJob.id);
  assert.equal((await reopened.dispatch('ai.changes', { id: bJob.id, path: 'b.md' })).after, 'after-b.md');
  await reopened.dispatch('ai.session.select', { id: a });
  assert.equal((await reopened.dispatch('ai.changes')).tasks[0].undone, true);
  assert.equal((await reopened.dispatch('ai.undo')).restoredCount, 0);
});

test('running tasks reject chat switching and creation without losing steering or switching the job session', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async (body, n) => {
    if (n === 1) { entered.resolve(); await release.promise; return reply('stale final'); }
    assert.ok(body.messages.some(m => m.role === 'user' && m.content.includes('Keep working in the current chat.')));
    return reply('Steered in the original chat.');
  });
  const a = (await f.ai.dispatch('ai.sessions')).activeSessionId;
  const b = (await f.ai.dispatch('ai.session.create', { title: 'Other chat' })).sessionId;
  await f.ai.dispatch('ai.session.select', { id: a });
  const id = (await f.ai.dispatch('ai.send', { message: 'Long running task.' })).jobId;
  await entered.promise;
  await assert.rejects(f.ai.dispatch('ai.session.select', { id: b }));
  await assert.rejects(f.ai.dispatch('ai.session.create', { title: 'Must not be created while busy' }));
  const accepted = await f.ai.dispatch('ai.steer', { id, message: 'Keep working in the current chat.' });
  assert.equal(accepted.jobId, id);
  const sessions = await f.ai.dispatch('ai.sessions'); assert.equal(sessions.sessions.length, 2); assert.equal(sessions.activeSessionId, a);
  release.resolve(); const job = await f.wait(f.ai, id); assert.equal(job.status, 'completed', job.error); assert.equal(job.sessionId, a);
  assert.ok(job.steering.some(s => s.id === accepted.instructionId && s.status === 'applied'));
  await f.ai.dispatch('ai.session.select', { id: b }); assert.deepEqual((await f.ai.dispatch('ai.history')).messages, []);
});

test('a send awaiting saved-file context rejects if the selected chat changes before the job starts', async t => {
  const reading = deferred(), releaseRead = deferred();
  const f = await fixture(t, () => reply('No request should be sent for a stale selected chat.'));
  const a = (await f.ai.dispatch('ai.sessions')).activeSessionId;
  const b = (await f.ai.dispatch('ai.session.create', { title: 'Next selected chat' })).sessionId;
  await f.ai.dispatch('ai.session.select', { id: a });
  await f.backend.saveFile({ path: 'delayed.md', content: 'delayed saved context', version: null });
  const read = f.backend.readFile.bind(f.backend);
  f.backend.readFile = async p => { if (p === 'delayed.md') { reading.resolve(); await releaseRead.promise; } return read(p); };
  const sent = f.ai.dispatch('ai.send', { message: 'Started from chat A.', contextPaths: ['delayed.md'] });
  const rejected = assert.rejects(sent);
  await reading.promise;
  await f.ai.dispatch('ai.session.select', { id: b });
  releaseRead.resolve(); await rejected;
  assert.equal(f.requests.length, 0, 'No model request should start with a stale selected chat.');
  assert.equal((await f.ai.dispatch('ai.history')).sessionId, b);
  assert.deepEqual((await f.ai.dispatch('ai.history')).messages, []);
  await f.ai.dispatch('ai.session.select', { id: a }); assert.deepEqual((await f.ai.dispatch('ai.history')).messages, []);
});

test('long history pages cover every message once and rendering keeps one hundred while the provider sees eighty', async t => {
  const messages = Array.from({ length: 257 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'history-message-' + i,
    ...(i === 200 ? { steeringId: 'historical-steer', steeringStatus: 'applied' } : {}) }));
  const f = await fixture(t, body => {
    const conversation = body.messages.filter(m => m.role !== 'system');
    assert.equal(conversation.length, 80, 'Provider context must not equal the rendering page or the whole archive.');
    assert.equal(conversation[0].content, 'history-message-178');
    assert.equal(conversation.at(-1).content, 'New current request.');
    assert.ok(conversation.every(m => Object.keys(m).sort().join(',') === 'content,role'), 'UI metadata must not leak into provider messages.');
    return reply('New current answer.');
  }, ({ root, legacyFile }) => writeLegacy(legacyFile, { root, messages, tasks: [] }));
  const latest = await f.ai.dispatch('ai.history');
  assert.equal(latest.totalMessages, 257); assert.equal(latest.messages.length, 100); assert.equal(latest.firstIndex, 157); assert.equal(latest.hasMore, true);
  let page = latest, recovered = [...latest.messages];
  while (page.hasMore) { page = await f.ai.dispatch('ai.history', { before: page.firstIndex, limit: 100 }); recovered = [...page.messages, ...recovered]; }
  assert.equal(page.firstIndex, 0); assert.deepEqual(recovered, messages);
  assert.equal(new Set(recovered.map(m => m.content)).size, 257);
  const empty = await f.ai.dispatch('ai.history', { before: 0, limit: 100 });
  assert.deepEqual(empty.messages, []); assert.equal(empty.firstIndex, 0); assert.equal(empty.hasMore, false); assert.equal(empty.totalMessages, 257);
  const small = await f.ai.dispatch('ai.history', { limit: 17 });
  assert.equal(small.messages.length, 17); assert.equal(small.firstIndex, 240);
  const job = await f.run(f.ai, 'New current request.'); assert.equal(job.status, 'completed', job.error);
  assert.equal(job.messages.length, 100); assert.equal(job.totalMessages, 259); assert.equal(job.firstIndex, 159);
  assert.equal(job.messages[0].content, 'history-message-159'); assert.equal(job.messages.at(-1).content, 'New current answer.');
  const reopened = f.reopen(); const archived = await reopened.dispatch('ai.history', { before: 100, limit: 100 });
  assert.equal(archived.totalMessages, 259); assert.deepEqual(archived.messages, messages.slice(0, 100));
});
