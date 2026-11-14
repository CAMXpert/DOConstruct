const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { AiService } = require('../src/ai/service.cjs');

const answer = (content, tool) => ({ choices: [{ message: { role: 'assistant', content,
  ...(tool ? { tool_calls: [{ id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args || {}) } }] } : {}) } }] });
async function fixture(t, handler, savedSettings) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doconstruct-rounds-'));
  const { DocumentBackend } = await import('../src/backend/index.mjs');
  const backend = new DocumentBackend(); await backend.createProject(path.join(directory, 'document'));
  const events = [], requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      const result = await handler(body, requests.length);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(500); res.end(error.stack); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const settingsPath = path.join(directory, 'profile', 'ai-settings.json');
  if (savedSettings) { await fs.mkdir(path.dirname(settingsPath), { recursive: true }); await fs.writeFile(settingsPath, JSON.stringify(savedSettings)); }
  const ai = new AiService({ settingsPath, backend, onEvent: e => events.push(e) });
  const loadedSettings = (await ai.dispatch('ai.settings')).settings;
  await ai.dispatch('ai.configure', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-rounds-fixture' });
  t.after(async () => {
    await ai.dispatch('ai.cancel').catch(() => {}); ai.dispose(); backend.dispose(); server.closeAllConnections();
    await new Promise(r => server.close(r));
    assert.equal(path.dirname(directory), os.tmpdir());
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const run = async message => {
    const id = (await ai.dispatch('ai.send', { message })).jobId;
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (ai.active?.id === id && ai.active.finished) return events.filter(e => e.type === 'ai' && e.job.id === id).at(-1).job;
      await new Promise(r => setTimeout(r, 10));
    }
    throw Error('Round-limit fixture did not finish.');
  };
  return { ai, backend, requests, loadedSettings, settingsPath, run };
}

test('new default is 100 rounds and loading an old sixteen-round setting upgrades it', async t => {
  const old = await fixture(t, () => answer('done'), { maxToolRounds: 16, allowProjectCommands: true, model: 'old-model' });
  assert.equal(old.loadedSettings.maxToolRounds, 100);
  assert.equal(old.loadedSettings.allowProjectCommands, true, 'Migration must retain command permission.');
  assert.equal(old.loadedSettings.model, 'old-model', 'Migration must retain model selection.');
  assert.equal(JSON.parse(await fs.readFile(old.settingsPath, 'utf8')).maxToolRounds, 100, 'Subsequent settings save must keep the upgraded value.');
  const fresh = await fixture(t, () => answer('done'));
  assert.equal(fresh.loadedSettings.maxToolRounds, 100);
  const larger = await fixture(t, () => answer('done'), { maxToolRounds: 140 });
  assert.equal(larger.loadedSettings.maxToolRounds, 140, 'A larger existing round allowance must remain intact.');
});

test('healthy work can perform twenty-four real model/tool rounds before its final response', async t => {
  const f = await fixture(t, (body, n) => {
    if (n > 1) {
      const result = JSON.parse(body.messages.at(-1).content);
      assert.ok(result.config?.sections, 'The next model request must receive the actual project inspection.');
    }
    return n <= 24 ? answer(null, { id: `inspect-${n}`, name: 'inspect_project' }) : answer('All twenty-four operations completed.');
  });
  const job = await f.run('Inspect the project over several steps.');
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.toolCalls.length, 24); assert.equal(f.requests.length, 25);
  assert.ok(job.toolCalls.every(c => c.status === 'completed'));
});

test('five consecutive identical failed calls stop a stalled task before wasting further rounds', async t => {
  const f = await fixture(t, (_, n) => answer(null, { id: `missing-${n}`, name: 'read_file', args: { path: 'missing.md' } }));
  const job = await f.run('Try reading one missing document.');
  assert.equal(job.status, 'failed');
  assert.match(job.error, /重复|相同|停滞|5/);
  assert.equal(f.requests.length, 5); assert.equal(job.toolCalls.length, 5);
  assert.ok(job.toolCalls.every(c => c.status === 'failed'));
});

test('repeated real command exit failures also stop even though the command tool returns a result', async t => {
  const f = await fixture(t, (_, n) => answer(null, { id: `command-failure-${n}`, name: 'run_project_command',
    args: { argv: ['{node}', '-e', 'console.error("deterministic failure");process.exit(7)'] } }));
  await f.ai.dispatch('ai.configure', { allowProjectCommands: true });
  const job = await f.run('Check a failing command.');
  assert.equal(job.status, 'failed'); assert.match(job.error, /重复|相同|停滞|5/);
  assert.equal(f.requests.length, 5); assert.equal(job.toolCalls.length, 5);
  assert.ok(job.toolCalls.every(c => c.status === 'failed'));
});

test('changing failed arguments represents a different attempt and resets the stalled-call count', async t => {
  const f = await fixture(t, (_, n) => n <= 12
    ? answer(null, { id: `different-${n}`, name: 'read_file', args: { path: `missing-${Math.floor((n - 1) / 4)}.md` } })
    : answer('Several different paths checked.'));
  const job = await f.run('Try different document names.');
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.toolCalls.length, 12); assert.equal(f.requests.length, 13);
});

test('a successful tool call resets repeated-failure detection even when later failures have the same signature', async t => {
  const f = await fixture(t, (_, n) => {
    if (n === 5) return answer(null, { id: 'successful-inspection', name: 'inspect_project' });
    if (n <= 9) return answer(null, { id: `retry-${n}`, name: 'read_file', args: { path: 'missing.md' } });
    return answer('Progress between attempts was retained.');
  });
  const job = await f.run('Inspect between attempts.');
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.toolCalls.length, 9); assert.equal(f.requests.length, 10);
  assert.equal(job.toolCalls[4].status, 'completed');
});
