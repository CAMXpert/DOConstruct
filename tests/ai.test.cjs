const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { AiService } = require('../src/ai/service.cjs');

const safeStorage = { isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from([...value].reverse().join('')),
  decryptString: bytes => [...bytes.toString()].reverse().join('') };
const assistant = (content = 'done', toolCalls) => ({ choices: [{ message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }] });
const call = (name, args = {}, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function fixture(t, handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doconstruct-ai-'));
  const root = path.join(directory, 'document');
  const { DocumentBackend } = await import('../src/backend/index.mjs');
  const events = [], requests = [];
  const backend = new DocumentBackend(); await backend.createProject(root);
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    try {
      const result = await handler(body, requests.length, req);
      if (result === undefined) return;
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const settingsPath = path.join(directory, 'profile', 'ai-settings.json');
  const skillRoot = path.resolve(__dirname, '../resources/skills');
  const ai = new AiService({ settingsPath, safeStorage, backend, skillRoot, onEvent: event => events.push(event) });
  await ai.dispatch('ai.configure', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock-model', apiKey: 'secret-test-key' });
  const wait = async id => {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const end = events.find(e => e.type === 'ai' && e.job.id === id && ['completed', 'failed', 'canceled'].includes(e.job.status));
      if (end) return end.job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('AI job did not finish');
  };
  t.after(async () => {
    ai.dispose(); backend.dispose(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(directory), os.tmpdir());
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { directory, root, settingsPath, ai, backend, events, requests, wait };
}

test('real tool loop reads/writes/validates files, uses skill, emits auto-file-refresh and never builds', async t => {
  const file = 'sections/01-introduction.md';
  const f = await fixture(t, (body, n) => {
    if (n === 1) return assistant(null, [call('inspect_project'), call('read_file', { path: file })]);
    if (n === 2) {
      const result = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
      assert.ok(result.some(x => x.path === file && x.content.includes('#')));
      return assistant(null, [call('write_file', { path: file, content: '# New title\n\nAI actually edited this.\n' }), call('validate_project')]);
    }
    assert.match(body.messages.at(-1).content, /"valid":true/);
    return assistant('已修改并检查骨架。');
  });
  let builds = 0; f.backend.build = () => { builds++; throw new Error('must not build'); };
  const skillAvailable = (await f.ai.dispatch('ai.skills')).skills.length;
  const started = await f.ai.dispatch('ai.send', { message: '修改第一章', ...(skillAvailable ? { skillId: 'paper-and-patent-writing' } : {}) });
  const job = await f.wait(started.jobId);
  assert.equal(job.status, 'completed', job.error);
  assert.match((await f.backend.readFile(file)).content, /actually edited/);
  assert.equal(builds, 0);
  assert.ok(f.events.some(e => e.type === 'files-changed' && e.paths.includes(file)));
  assert.equal(job.toolCalls.filter(c => c.status === 'completed').length, 4);
  assert.equal(f.requests.length, 3);
  assert.equal((await f.ai.dispatch('ai.history')).messages.at(-1).content, '已修改并检查骨架。');
  if (skillAvailable) assert.match(f.requests[0].messages[0].content, /先确定格式与论证/);
});

test('tool harness handles missing reads/path escape/hidden credentials as real errors and can recover', async t => {
  const f = await fixture(t, (body, n) => {
    if (n === 1) return assistant(null, [call('write_file', { path: 'sections/01-introduction.md', content: 'overwrite' }),
      call('read_file', { path: '../outside.md' }), call('read_file', { path: '.env' }), call('run_project_command'), call('run_shell_command', { command: 'Write-Output nope' })]);
    const errors = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content).error);
    assert.deepEqual(errors.map(e => e.code), ['CONFLICT', 'AI_DOCUMENT_PATH', 'AI_DOCUMENT_PATH', 'AI_COMMAND_DISABLED', 'AI_COMMAND_DISABLED']);
    return assistant('No unsafe writes were performed.');
  });
  const before = (await f.backend.readFile('sections/01-introduction.md')).content;
  const job = await f.wait((await f.ai.dispatch('ai.send', { message: 'test failed tools' })).jobId);
  assert.equal(job.status, 'completed', job.error);
  assert.equal((await f.backend.readFile('sections/01-introduction.md')).content, before);
  assert.ok(!f.requests[0].tools.some(x => x.function.name === 'run_project_command'));
  assert.ok(!f.requests[0].tools.some(x => x.function.name === 'run_shell_command'));
});

test('skeleton updates preserve styles, create real source, validate and undo one batch', async t => {
  const f = await fixture(t, (body, n) => {
    if (n === 1) return assistant(null, [call('inspect_project'), call('write_file', { path: 'content/new.md', content: '# 新章节\n' })]);
    if (n === 2) return assistant(null, [call('update_outline', { title: 'New skeleton', sections: [{ id: 'new', title: '新章节', path: 'content/new.md', enabled: true }] }), call('validate_project')]);
    return assistant('骨架已完成。');
  });
  const before = await f.backend.getProject();
  const job = await f.wait((await f.ai.dispatch('ai.send', { message: '新建骨架' })).jobId);
  assert.equal(job.status, 'completed', job.error);
  assert.equal((await f.backend.getProject()).config.sections.length, 1);
  assert.deepEqual((await f.backend.getProject()).config.style, before.config.style);
  assert.equal((await f.ai.dispatch('ai.undo')).restoredCount, 2);
  assert.equal((await f.backend.getProject()).title, before.title);
  await assert.rejects(fs.access(path.join(f.root, 'content/new.md')));
});

test('credentials persist encrypted, do not leak via settings/events/history; source file external edits block overwrite', async t => {
  let f;
  f = await fixture(t, async (body, n, req) => {
    assert.equal(req.headers.authorization, 'Bearer secret-test-key');
    if (n === 1) return assistant(null, [call('read_file', { path: 'sections/01-introduction.md' })]);
    if (n === 2) {
      await fs.writeFile(path.join(f.root, 'sections/01-introduction.md'), '# external owner edit\n');
      return assistant(null, [call('write_file', { path: 'sections/01-introduction.md', content: 'must not overwrite' })]);
    }
    assert.match(body.messages.at(-1).content, /CONFLICT/); return assistant('kept external edit');
  });
  const raw = await fs.readFile(f.settingsPath, 'utf8'); assert.ok(!raw.includes('secret-test-key')); assert.ok(raw.includes('encryptedKey'));
  assert.equal((await f.ai.dispatch('ai.settings')).settings.hasApiKey, true);
  const reloaded = new AiService({ settingsPath: f.settingsPath, safeStorage, backend: f.backend });
  assert.equal((await reloaded.dispatch('ai.settings')).settings.hasApiKey, true);
  const job = await f.wait((await f.ai.dispatch('ai.send', { message: 'check conflict' })).jobId);
  assert.equal(job.status, 'completed', job.error);
  assert.equal((await f.backend.readFile('sections/01-introduction.md')).content, '# external owner edit\n');
  assert.ok(!JSON.stringify(f.events).includes('secret-test-key'));
  assert.ok(!JSON.stringify(await f.ai.dispatch('ai.settings')).includes('secret-test-key'));
  assert.ok(!JSON.stringify(await f.ai.dispatch('ai.history')).includes('secret-test-key'));
  await f.ai.dispatch('ai.configure', { clearApiKey: true });
  assert.equal((await f.ai.dispatch('ai.settings')).settings.hasApiKey, false);
});

test('cancel aborts in-flight API and a project switch prevents late tool writes to the new project', async t => {
  let release;
  const f = await fixture(t, async () => new Promise(resolve => { release = resolve; }));
  const id = (await f.ai.dispatch('ai.send', { message: 'wait' })).jobId;
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.ai.dispatch('ai.cancel', { id })).canceled, true);
  assert.equal((await f.wait(id)).status, 'canceled');
  release(assistant('ignored canceled response'));
  const secondRoot = path.join(f.directory, 'second');
  await f.backend.createProject(secondRoot);
  assert.deepEqual((await f.ai.dispatch('ai.history')).messages, []);
  f.requests.length = 0;
  // Directly exercise the guard with the original captured root/epoch, not a fresh project context.
  const oldJob = { root: f.root, epoch: f.backend.epoch - 1, controller: new AbortController() };
  await assert.rejects(f.ai.guard(oldJob), e => e.code === 'AI_PROJECT_CHANGED');
  await assert.rejects(f.ai.tool(oldJob, 'write_file', { path: 'wrong.md', content: 'wrong' }), e => e.code === 'AI_PROJECT_CHANGED');
  await assert.rejects(fs.access(path.join(secondRoot, 'wrong.md')));
});

test('late model tool response after direct project switch cannot write either project', async t => {
  let release;
  const f = await fixture(t, () => new Promise(resolve => { release = resolve; }));
  const id = (await f.ai.dispatch('ai.send', { message: 'create a file later' })).jobId;
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  const nextRoot = path.join(f.directory, 'next-project');
  await f.backend.createProject(nextRoot);
  release(assistant(null, [call('write_file', { path: 'late.md', content: '# This must not exist' })]));
  const job = await f.wait(id);
  assert.equal(job.status, 'failed'); assert.match(job.error, /项目已切换/);
  await assert.rejects(fs.access(path.join(f.root, 'late.md')));
  await assert.rejects(fs.access(path.join(nextRoot, 'late.md')));
  assert.deepEqual((await f.ai.dispatch('ai.history')).messages, []);
});

test('cancel awaits harness finalization and terminates a running configured command', async t => {
  const f = await fixture(t, () => assistant(null, [call('run_project_command')]));
  const p = await f.backend.getProject();
  p.config.command = { argv: ['{node}', '-e', 'setTimeout(()=>require("node:fs").writeFileSync("late.txt","late"),10000)'] };
  await f.backend.saveConfig({ config: p.config, version: p.version });
  await f.ai.dispatch('ai.configure', { allowProjectCommands: true });
  const id = (await f.ai.dispatch('ai.send', { message: 'Run configured command' })).jobId;
  while (!f.ai.active.commandId) await new Promise(resolve => setTimeout(resolve, 5));
  const commandId = f.ai.active.commandId;
  assert.equal((await f.ai.dispatch('ai.cancel', { id })).canceled, true);
  assert.equal(f.ai.active.finished, true);
  assert.equal((await f.wait(id)).status, 'canceled');
  assert.equal(f.backend.getJob(commandId).status, 'canceled');
  const started = Date.now();
  while (f.backend.active && Date.now() - started < 2000) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.backend.active, null);
  await assert.rejects(fs.access(path.join(f.root, 'late.txt')));
});

test('command tool still runs the configured default when argv is omitted', async t => {
  const f = await fixture(t, (body, n) => n === 1 ? assistant(null, [call('run_project_command')]) : assistant('command checked'));
  const p = await f.backend.getProject();
  p.config.command = { argv: ['{node}', '-e', 'console.log("real configured command")'] };
  await f.backend.saveConfig({ config: p.config, version: p.version });
  await f.ai.dispatch('ai.configure', { allowProjectCommands: true });
  const job = await f.wait((await f.ai.dispatch('ai.send', { message: '运行配置的校验命令' })).jobId);
  assert.equal(job.status, 'completed', job.error);
  const result = JSON.parse(f.requests[1].messages.at(-1).content);
  assert.equal(result.status, 'completed'); assert.match(result.logs.join('\n'), /real configured command/);
  assert.equal(result.exitCode, 0); assert.equal(result.cwd, f.root);
});

test('enabled command tool executes supplied argv without project configuration, refreshes edited files, and leaves preview alone', async t => {
  const f = await fixture(t, (body, n) => n === 1 ? assistant(null, [call('run_project_command', {
    argv: ['{node}', '-e', 'require("node:fs").writeFileSync("generated.html","<h1>command generated</h1>"); console.log(process.cwd()); console.log(process.argv[1]);', 'a spaced argument & 中文'],
    cwd: 'sections', outputs: ['sections/generated.html']
  })]) : assistant('actual argv command finished'));
  assert.equal((await f.backend.getProject()).config.command, undefined);
  await f.ai.dispatch('ai.configure', { allowProjectCommands: true });
  const job = await f.wait((await f.ai.dispatch('ai.send', { message: '执行一条命令' })).jobId);
  assert.equal(job.status, 'completed', job.error);
  const result = JSON.parse(f.requests[1].messages.at(-1).content);
  assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 0);
  assert.equal(result.cwd, path.join(f.root, 'sections')); assert.match(result.stdout, /a spaced argument & 中文/);
  assert.equal(await fs.readFile(path.join(f.root, 'sections/generated.html'), 'utf8'), '<h1>command generated</h1>');
  assert.equal(f.backend.project.latestPreview, null);
  assert.ok(![...f.backend.jobs.values()].some(j => j.kind === 'build' || j.htmlPath));
  assert.ok(f.requests[0].tools.some(x => x.function.name === 'run_shell_command'));
  assert.match(f.requests[0].messages[0].content, /Windows PowerShell/);
  assert.match(job.toolCalls[0].command, /a spaced argument/); assert.match(job.toolCalls[0].output, /exit: 0/);
});

test('enabled PowerShell command runs without a configured default and reports actual stderr and nonzero exit', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, (body, n) => n === 1 ? assistant(null, [call('run_shell_command', {
    command: "[IO.File]::WriteAllText((Join-Path (Get-Location) 'shell-result.txt'), '測試 & $value'); Write-Output '中文stdout'; [Console]::Error.WriteLine('stderr detail secret-test-key'); exit 7",
    cwd: 'sections'
  })]) : assistant('observed command failure'));
  await f.ai.dispatch('ai.configure', { allowProjectCommands: true });
  const job = await f.wait((await f.ai.dispatch('ai.send', { message: 'run PowerShell and inspect failure' })).jobId);
  assert.equal(job.status, 'completed', job.error);
  const result = JSON.parse(f.requests[1].messages.at(-1).content);
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 7);
  assert.match(result.stdout, /中文stdout/); assert.match(result.stderr, /stderr detail \[API Key\]/);
  assert.equal(result.cwd, path.join(f.root, 'sections')); assert.equal(result.error.code, 'PROCESS_FAILED');
  assert.equal(job.toolCalls[0].status, 'failed'); assert.match(job.toolCalls[0].output, /exit: 7/);
  assert.equal(await fs.readFile(path.join(f.root, 'sections/shell-result.txt'), 'utf8'), '測試 & $value');
  assert.ok(!JSON.stringify(f.events).includes('secret-test-key'));
  assert.ok(!JSON.stringify(result).includes('secret-test-key'));
});

test('a command failure returns executable errors and malformed arguments never start a job', async t => {
  const f = await fixture(t, (body, n) => n === 1 ? assistant(null, [call('run_project_command', { argv: ['doconstruct-nonexistent-executable'] }),
    call('run_project_command', { argv: [] }), call('run_shell_command', { command: '' })]) : assistant('all failures inspected'));
  await f.ai.dispatch('ai.configure', { allowProjectCommands: true });
  const job = await f.wait((await f.ai.dispatch('ai.send', { message: 'report failed executable' })).jobId);
  const results = f.requests[1].messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.equal(results[0].status, 'failed'); assert.equal(results[0].error.code, 'PROCESS_START');
  assert.equal(results[1].error.code, 'AI_TOOL_ARGS');
  assert.equal(results[2].error.code, process.platform === 'win32' ? 'AI_TOOL_ARGS' : 'AI_SHELL_PLATFORM');
  assert.equal(f.backend.jobs.size, 1);
  assert.ok(job.toolCalls.every(c => c.status === 'failed'));
});

test('directory tool discovers actual resources lazily; undo refuses to overwrite a later user edit', async t => {
  const f = await fixture(t, (body, n) => {
    if (n === 1) return assistant(null, [call('list_files', { path: 'figures' }), call('read_file', { path: 'sections/01-introduction.md' })]);
    if (n === 2) {
      assert.equal(JSON.parse(body.messages.find(m => m.role === 'tool').content).entries[0].name, 'figure.png');
      return assistant(null, [call('write_file', { path: 'sections/01-introduction.md', content: '# AI modified\n' })]);
    }
    return assistant('done');
  });
  await fs.mkdir(path.join(f.root, 'figures')); await fs.writeFile(path.join(f.root, 'figures/figure.png'), Buffer.from([137, 80, 78, 71]));
  const job = await f.wait((await f.ai.dispatch('ai.send', { message: '检查图片目录并修改第一章' })).jobId);
  assert.equal(job.status, 'completed', job.error);
  await fs.writeFile(path.join(f.root, 'sections/01-introduction.md'), '# new user edit\n');
  await assert.rejects(f.ai.dispatch('ai.undo'), e => e.code === 'CONFLICT');
  assert.equal((await f.backend.readFile('sections/01-introduction.md')).content, '# new user edit\n');
});

test('HTTP errors are visible with API key redacted; credentials never fall back to plain text', async t => {
  const f = await fixture(t, () => { throw new Error('provider rejected secret-test-key'); });
  const job = await f.wait((await f.ai.dispatch('ai.send', { message: 'provider failure' })).jobId);
  assert.equal(job.status, 'failed'); assert.match(job.error, /500/); assert.ok(!job.error.includes('secret-test-key'));
  assert.ok(!JSON.stringify(f.events).includes('secret-test-key'));
  const unavailable = new AiService({ settingsPath: path.join(f.directory, 'unencrypted/settings.json'),
    safeStorage: { isEncryptionAvailable: () => false }, backend: f.backend });
  await assert.rejects(unavailable.dispatch('ai.configure', { apiKey: 'never-store-this' }), e => e.code === 'AI_CREDENTIAL');
  await assert.rejects(fs.access(path.join(f.directory, 'unencrypted/settings.json')));
  await assert.rejects(f.ai.dispatch('ai.configure', { baseUrl: 'https://user:password@example.com/v1' }), e => e.code === 'AI_URL');
});

test('simultaneous sends admit one harness only; provider reasoning is preserved only when returned', async t => {
  const f = await fixture(t, (body, n) => {
    if (n === 1) return { choices: [{ message: { role: 'assistant', content: null, reasoning_content: 'provider-required-tool-chain', tool_calls: [call('inspect_project')] } }] };
    assert.equal(body.messages.find(m => m.tool_calls).reasoning_content, 'provider-required-tool-chain');
    return assistant('done');
  });
  const calls = await Promise.allSettled([f.ai.dispatch('ai.send', { message: 'first' }), f.ai.dispatch('ai.send', { message: 'second' })]);
  assert.equal(calls.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(calls.find(x => x.status === 'rejected').reason.code, 'AI_BUSY');
  const id = calls.find(x => x.status === 'fulfilled').value.jobId;
  assert.equal((await f.wait(id)).status, 'completed');
  assert.equal((await f.ai.dispatch('ai.history')).messages.length, 2);
  assert.ok(!JSON.stringify(await f.ai.dispatch('ai.history')).includes('provider-required-tool-chain'));
  assert.match(f.requests[0].messages[0].content, /doconstruct.json.sections 作为唯一/);
});

test('Responses uses the same real tools and preserves encrypted reasoning/output items between requests', async t => {
  const file = 'sections/01-introduction.md';
  const reasoning = { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'encrypted-reasoning-state' };
  const read = { id: 'fc_1', type: 'function_call', call_id: 'read1', name: 'read_file', arguments: JSON.stringify({ path: file }) };
  const f = await fixture(t, (body, n, req) => {
    assert.equal(req.url, '/v1/responses'); assert.equal(body.store, false);
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.ok(body.tools.every(tool => tool.type === 'function' && tool.name && !tool.function && tool.strict === false));
    if (n === 1) return { status: 'completed', output: [reasoning, read] };
    assert.deepEqual(body.input.find(item => item.id === reasoning.id), reasoning);
    assert.deepEqual(body.input.find(item => item.id === read.id), read);
    if (n === 2) {
      const result = JSON.parse(body.input.find(item => item.type === 'function_call_output' && item.call_id === 'read1').output);
      assert.equal(result.path, file); assert.match(result.content, /#/);
      return { status: 'completed', output: [{ id: 'fc_2', type: 'function_call', call_id: 'write1', name: 'write_file',
        arguments: JSON.stringify({ path: file, content: '# Responses actually edited this file\n' }) }] };
    }
    const saved = JSON.parse(body.input.find(item => item.type === 'function_call_output' && item.call_id === 'write1').output);
    assert.equal(saved.path, file); assert.ok(saved.version);
    return { status: 'completed', output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Responses 修改已完成。', annotations: [] }] }] };
  });
  await f.ai.dispatch('ai.configure', { apiMode: 'responses' });
  const reloaded = new AiService({ settingsPath: f.settingsPath, safeStorage, backend: f.backend });
  assert.equal((await reloaded.dispatch('ai.settings')).settings.apiMode, 'responses');
  const job = await f.wait((await f.ai.dispatch('ai.send', { message: '用 Responses 修改正文' })).jobId);
  assert.equal(job.status, 'completed', job.error);
  assert.match((await f.backend.readFile(file)).content, /Responses actually edited/);
  assert.equal((await f.ai.dispatch('ai.history')).messages.at(-1).content, 'Responses 修改已完成。');
  assert.ok(!JSON.stringify(await f.ai.dispatch('ai.history')).includes('encrypted-reasoning-state'));
  assert.equal(f.requests.length, 3);
  await assert.rejects(f.ai.dispatch('ai.configure', { apiMode: 'invalid' }), e => e.code === 'AI_MODE');
});

test('change review exposes task summaries and exact snapshots without broadcasting document bodies or reasoning', async t => {
  const file = 'sections/01-introduction.md', created = 'content/review.md';
  const f = await fixture(t, (body, n) => {
    if (n === 1) return { choices: [{ message: { role: 'assistant', content: '先讀取文件，再修改。', reasoning_content: 'PRIVATE REASONING', tool_calls: [call('inspect_project'), call('read_file', { path: file })] } }] };
    if (n === 2) return assistant(null, [call('write_file', { path: file, content: '# Reviewed\n\nEXACT AFTER CONTENT\n' }), call('write_file', { path: created, content: '# Created\n' })]);
    if (n === 3) return assistant(null, [call('update_outline', { sections: [{ id: 'review', title: 'Review', path: created }] })]);
    return assistant('## 已完成\n\n**可查看修改**');
  });
  const before = (await f.backend.readFile(file)).content;
  const job = await f.wait((await f.ai.dispatch('ai.send', { message: 'review changes' })).jobId);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.changes.length, 3);
  assert.ok(!JSON.stringify(f.events).includes('EXACT AFTER CONTENT'));
  assert.ok(!JSON.stringify(f.events).includes('PRIVATE REASONING'));
  assert.ok(job.messages.some(m => m.content === '先讀取文件，再修改。'));
  const tasks = (await f.ai.dispatch('ai.changes')).tasks;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].id, job.id);
  const detail = await f.ai.dispatch('ai.changes', { id: job.id, path: file });
  assert.equal(detail.before, before); assert.equal(detail.after, '# Reviewed\n\nEXACT AFTER CONTENT\n');
  assert.equal((await f.ai.dispatch('ai.changes', { id: job.id, path: created })).before, null);
  const outline = await f.ai.dispatch('ai.changes', { id: job.id, path: 'doconstruct.json' });
  assert.equal(JSON.parse(outline.after).sections[0].path, created);
  assert.equal((await f.ai.dispatch('ai.undo')).restoredCount, 3);
  assert.equal((await f.ai.dispatch('ai.changes')).tasks[0].undone, true);
  assert.equal((await f.ai.dispatch('ai.changes', { id: job.id, path: file })).after, detail.after);
  await assert.rejects(f.ai.dispatch('ai.changes', { id: job.id, path: '../outside.md' }), e => e.code === 'AI_CHANGE');
  await f.backend.createProject(path.join(f.directory, 'other-project'));
  assert.deepEqual((await f.ai.dispatch('ai.changes')).tasks, []);
  await assert.rejects(f.ai.dispatch('ai.changes', { id: job.id, path: file }), e => e.code === 'AI_CHANGE');
});

test('failed tasks retain the first preimage and final write for review and undo', async t => {
  const file = 'sections/01-introduction.md';
  const f = await fixture(t, (body, n) => {
    if (n === 1) return assistant(null, [call('read_file', { path: file })]);
    if (n === 2) return assistant(null, [call('write_file', { path: file, content: 'intermediate write' }), call('write_file', { path: file, content: 'final write' })]);
    throw new Error('local fake provider failed after writes');
  });
  const before = (await f.backend.readFile(file)).content;
  const job = await f.wait((await f.ai.dispatch('ai.send', { message: 'two writes then fail' })).jobId);
  assert.equal(job.status, 'failed');
  assert.equal((await f.ai.dispatch('ai.changes')).tasks[0].status, 'failed');
  const detail = await f.ai.dispatch('ai.changes', { id: job.id, path: file });
  assert.equal(detail.before, before); assert.equal(detail.after, 'final write');
  assert.equal((await f.ai.dispatch('ai.undo')).restoredCount, 1);
  assert.equal((await f.backend.readFile(file)).content, before);
});

test('change snapshots and undo batches share a twelve-task history cap', async t => {
  const f = await fixture(t, (body, n) => n % 2 ? assistant(null, [call('write_file', { path: `content/task-${n}.md`, content: `task ${n}` })]) : assistant('done'));
  const ids = [];
  for (let i = 0; i < 13; i++) { const id = (await f.ai.dispatch('ai.send', { message: 'task ' + i })).jobId; await f.wait(id); ids.push(id); }
  const tasks = (await f.ai.dispatch('ai.changes')).tasks;
  assert.equal(tasks.length, 12); assert.equal(tasks[0].id, ids[1]);
  await assert.rejects(f.ai.dispatch('ai.changes', { id: ids[0], path: 'content/task-1.md' }), e => e.code === 'AI_CHANGE');
  for (let i = 0; i < 12; i++) assert.equal((await f.ai.dispatch('ai.undo')).restoredCount, 1);
  assert.equal((await f.ai.dispatch('ai.undo')).restoredCount, 0);
  assert.ok((await f.ai.dispatch('ai.changes')).tasks.every(task => task.undone));
});

test('reopening AI service restores snapshots and undo with version protection, then persists the undone state', async t => {
  const file = 'sections/01-introduction.md';
  const f = await fixture(t, (body, n) => n === 1 ? assistant(null, [call('read_file', { path: file })]) : n === 2 ? assistant(null, [call('write_file', { path: file, content: '# Persisted AI write\n' })]) : assistant('done'));
  const before = (await f.backend.readFile(file)).content;
  const job = await f.wait((await f.ai.dispatch('ai.send', { message: 'persist review' })).jobId);
  const reopened = new AiService({ settingsPath: f.settingsPath, safeStorage, backend: f.backend });
  assert.equal((await reopened.dispatch('ai.history')).changeTasks[0].id, job.id);
  assert.equal((await reopened.dispatch('ai.changes', { id: job.id, path: file })).before, before);
  const aiWrite = await f.backend.readFile(file);
  const userWrite = await f.backend.saveFile({ path: file, content: '# Later user edit\n', version: aiWrite.version });
  await assert.rejects(reopened.dispatch('ai.undo'), e => e.code === 'CONFLICT');
  await f.backend.saveFile({ path: file, content: aiWrite.content, version: userWrite.version });
  assert.equal((await reopened.dispatch('ai.undo')).restoredCount, 1);
  assert.equal((await f.backend.readFile(file)).content, before);
  const again = new AiService({ settingsPath: f.settingsPath, safeStorage, backend: f.backend });
  assert.equal((await again.dispatch('ai.changes')).tasks[0].undone, true);
  assert.equal((await again.dispatch('ai.undo')).restoredCount, 0);
  assert.equal((await again.dispatch('ai.changes', { id: job.id, path: file })).after, aiWrite.content);
  const historyFile = (await f.ai.session(f.root)).file, saved = JSON.parse(await fs.readFile(historyFile, 'utf8'));
  saved.tasks[0].changes[0].path = '../outside.md';
  await fs.writeFile(historyFile, JSON.stringify(saved));
  const invalid = new AiService({ settingsPath: f.settingsPath, safeStorage, backend: f.backend });
  assert.deepEqual((await invalid.dispatch('ai.changes')).tasks, []);
});
