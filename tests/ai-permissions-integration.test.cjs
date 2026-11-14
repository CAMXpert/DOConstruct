const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { AiService } = require('../src/ai/service.cjs');

const tool = (name, args = {}, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const answer = (content, calls) => ({ choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) } }] });

async function fixture(t, calls = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doconstruct-permissions-'));
  const { DocumentBackend } = await import('../src/backend/index.mjs');
  const backend = new DocumentBackend();
  await backend.createProject(path.join(directory, 'document'));
  const root = (await backend.getProject()).root;
  await fs.mkdir(path.join(root, 'allowed/nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'allowed/nested/public.md'), '# public allowed content');
  await fs.writeFile(path.join(root, 'allowed/private.md'), '# SECRET sibling content');
  await fs.writeFile(path.join(root, 'outside.md'), '# SECRET outside content');
  const requests = [], events = [], services = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      const reply = body.messages.some(m => m.role === 'tool') ? answer('Actual tool results reviewed.') : answer(null, calls);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply));
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const settingsPath = path.join(directory, 'profile/ai-settings.json');
  const reopen = () => { const ai = new AiService({ settingsPath, backend, onEvent: event => events.push(event) }); services.push(ai); return ai; };
  const ai = reopen();
  await ai.dispatch('ai.configure', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-permissions-test' });
  const run = async (message = 'Execute the requested document task.', options = {}) => {
    const id = (await ai.dispatch('ai.send', { message, ...options })).jobId;
    for (let i = 0; i < 500; i++) {
      if (ai.active?.id === id && ai.active.finished) return events.filter(e => e.type === 'ai' && e.job.id === id).at(-1).job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('AI permissions fixture did not finish.');
  };
  t.after(async () => {
    for (const service of services) { await service.dispatch('ai.cancel').catch(() => {}); service.dispose(); }
    backend.dispose();
    for (let i = 0; backend.active && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(directory), os.tmpdir());
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const results = () => requests.at(-1).messages.filter(m => m.role === 'tool').map(m => ({ id: m.tool_call_id, ...JSON.parse(m.content) }));
  return { directory, root, settingsPath, backend, ai, requests, events, run, results, reopen };
}

test('read-only workspace advertises no writing/commands and rejects forced calls without modifying files', async t => {
  const f = await fixture(t, [tool('read_file', { path: 'outside.md' }),
    tool('write_file', { path: 'outside.md', content: 'WRONG WRITE' }), tool('update_outline', { sections: [] }),
    tool('run_project_command', { argv: ['{node}', '-e', 'process.exit(0)'] }), tool('run_shell_command', { command: 'Write-Output no' })]);
  await f.ai.dispatch('ai.permissions.configure', { readFiles: true, writeFiles: false, allowCommands: false, allowedPaths: ['.'] });
  const configBefore = await fs.readFile(path.join(f.root, 'doconstruct.json'));
  const job = await f.run();
  assert.equal(job.status, 'completed', job.error);
  const advertised = f.requests[0].tools.map(t => t.function.name);
  assert.ok(advertised.includes('read_file'));
  for (const name of ['write_file', 'update_outline', 'run_project_command', 'run_shell_command']) assert.ok(!advertised.includes(name), name);
  const results = f.results();
  assert.match(results[0].content, /SECRET outside/);
  for (const result of results.slice(1)) assert.equal(result.error?.code,
    result.id.startsWith('run_') ? 'AI_COMMAND_DISABLED' : 'AI_PERMISSION', result.id);
  assert.equal(await fs.readFile(path.join(f.root, 'outside.md'), 'utf8'), '# SECRET outside content');
  assert.deepEqual(await fs.readFile(path.join(f.root, 'doconstruct.json')), configBefore);
});

test('file scope filters navigation, reads, context and validation without querying ungranted content', async t => {
  const f = await fixture(t, [tool('list_files', { path: '' }, 'root'), tool('list_files', { path: 'allowed' }, 'parent'),
    tool('list_files', { path: 'allowed/nested' }, 'nested'),
    tool('read_file', { path: 'allowed/nested/public.md' }, 'public'), tool('read_file', { path: 'outside.md' }, 'outside'), tool('validate_project')]);
  await f.ai.dispatch('ai.permissions.configure', { allowedPaths: ['allowed/nested/public.md'], allowCommands: false });
  const reads = [], originalRead = f.backend.readFile.bind(f.backend);
  f.backend.readFile = async relative => { reads.push(relative); return originalRead(relative); };
  const job = await f.run();
  assert.equal(job.status, 'completed', job.error);
  const results = f.results(), byId = Object.fromEntries(results.map(r => [r.id, r]));
  assert.deepEqual(byId.root.entries.map(e => e.name), ['allowed']);
  assert.deepEqual(byId.parent.entries.map(e => e.name), ['nested']);
  assert.deepEqual(byId.nested.entries.map(e => e.name), ['public.md']);
  assert.match(byId.public.content, /public allowed content/);
  assert.equal(byId.outside.error?.code, 'AI_PERMISSION');
  assert.ok(reads.every(relative => relative === 'allowed/nested/public.md'), JSON.stringify(reads));
  assert.ok(!JSON.stringify(results).includes('SECRET'));
  const requestCount = f.requests.length, readCount = reads.length;
  await assert.rejects(f.ai.dispatch('ai.send', { message: 'Hidden context must not bypass scope.', contextPaths: ['outside.md'] }), e => e.code === 'AI_PERMISSION');
  assert.equal(f.requests.length, requestCount); assert.equal(reads.length, readCount);
});

test('metadata-only permissions refuse file tools and selected context before any file read', async t => {
  const f = await fixture(t, [tool('inspect_project'), tool('list_files'), tool('read_file', { path: 'outside.md' }), tool('validate_project')]);
  await f.ai.dispatch('ai.permissions.configure', { readFiles: false, writeFiles: false, allowCommands: false, allowedPaths: [] });
  let reads = 0;
  f.backend.readFile = async () => { reads++; throw Error('File reads forbidden by test.'); };
  const job = await f.run();
  assert.equal(job.status, 'completed', job.error);
  assert.deepEqual(f.requests[0].tools.map(t => t.function.name), ['inspect_project']);
  assert.ok(f.results()[0].config);
  for (const result of f.results().slice(1)) assert.equal(result.error?.code, 'AI_PERMISSION');
  await assert.rejects(f.ai.dispatch('ai.send', { message: 'No context.', contextPaths: ['outside.md'] }), e => e.code === 'AI_PERMISSION');
  assert.equal(reads, 0);
});

test('workspace permissions persist independently and invalid command combinations preserve the previous grant', async t => {
  const f = await fixture(t);
  const restricted = { readFiles: true, writeFiles: false, allowCommands: false, allowedPaths: ['allowed/nested'] };
  await f.ai.dispatch('ai.permissions.configure', restricted);
  await assert.rejects(f.ai.dispatch('ai.permissions.configure', { allowCommands: true }), e => e.code === 'AI_PERMISSIONS');
  assert.deepEqual((await f.ai.dispatch('ai.permissions')).permissions, restricted);
  const reopened = f.reopen();
  assert.deepEqual((await reopened.dispatch('ai.permissions')).permissions, restricted);
  await f.backend.createProject(path.join(f.directory, 'other-document'));
  const other = (await f.ai.dispatch('ai.permissions')).permissions;
  assert.deepEqual(other, { readFiles: true, writeFiles: true, allowCommands: false, allowedPaths: ['.'] });
  await f.ai.dispatch('ai.permissions.configure', { writeFiles: false, allowedPaths: [] });
  await f.backend.openProject(f.root);
  assert.deepEqual((await f.ai.dispatch('ai.permissions')).permissions, restricted);
});

test('a prior global command flag does not silently grant new workspaces commands, while legacy migration preserves the old grant', async t => {
  const f = await fixture(t);
  await f.ai.dispatch('ai.configure', { allowProjectCommands: true });
  assert.equal((await f.ai.dispatch('ai.permissions')).permissions.allowCommands, true, 'Explicit legacy configure must still enable this current workspace.');
  await f.backend.createProject(path.join(f.directory, 'new-without-legacy'));
  const newRoot = (await f.backend.getProject()).root;
  assert.equal((await f.ai.dispatch('ai.permissions')).permissions.allowCommands, false);
  const reopened = f.reopen();
  assert.equal((await reopened.dispatch('ai.permissions')).permissions.allowCommands, false);
  const newHash = crypto.createHash('sha256').update(newRoot).digest('hex');
  const index = JSON.parse(await fs.readFile(path.join(path.dirname(f.settingsPath), 'ai-history', newHash, 'index.json'), 'utf8'));
  assert.equal(index.permissions.allowCommands, false, 'The initial index must persist its own grant rather than re-derive it from global settings.');

  await f.backend.createProject(path.join(f.directory, 'old-workspace'));
  const legacyRoot = (await f.backend.getProject()).root;
  const legacyHash = crypto.createHash('sha256').update(legacyRoot).digest('hex');
  const legacyFile = path.join(path.dirname(f.settingsPath), 'ai-history', legacyHash + '.json');
  await fs.mkdir(path.dirname(legacyFile), { recursive: true });
  const legacy = JSON.stringify({ root: legacyRoot, messages: [{ role: 'user', content: 'Old installed workspace history.' }], tasks: [] });
  await fs.writeFile(legacyFile, legacy);
  assert.equal((await f.ai.dispatch('ai.permissions')).permissions.allowCommands, true, 'Actual old-history migration retains the previously enabled command flag.');
  assert.equal(await fs.readFile(legacyFile, 'utf8'), legacy);
});
