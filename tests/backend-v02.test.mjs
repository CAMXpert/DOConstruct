import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DocumentBackend } from '../src/backend/index.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doconstruct-v02-'));
  const events = [];
  const backend = new DocumentBackend({ pandocPath: path.join(ROOT, 'resources/vendor/pandoc/pandoc.exe'),
    pythonPath: path.join(ROOT, 'resources/vendor/python/python.exe'), onEvent: event => events.push(event) });
  t.after(async () => { backend.dispose(); assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); });
  await backend.createProject(root, options);
  return { root, backend, events };
}
async function waitFor(check, message) {
  for (let i = 0; i < 100; i++) { const value = check(); if (value) return value; await delay(20); }
  assert.fail(message || 'Expected a file-change notification.');
}

test('blank skeleton creation, ordered sections, rename/reorder/remove retain source files', async t => {
  const { root, backend } = await fixture(t, { kind: 'blank', title: '从零开始' });
  let p = await backend.getProject(); assert.equal(p.title, '从零开始'); assert.deepEqual(p.config.sections, []);
  p = await backend.createSection({ title: '方法' }); const method = p.config.sections[0];
  p = await backend.createSection({ title: '引言', path: 'assets/intro/body.md', content: '# 引言\n真实文本\n' });
  assert.equal(p.config.sections.length, 2); assert.equal(await fs.readFile(path.join(root, method.path), 'utf8'), '# 方法\n\n');
  const intro = p.config.sections[1]; intro.title = '背景'; p.config.sections.reverse();
  p = await backend.saveConfig({ config: p.config, version: p.version }); assert.equal(p.config.sections[0].title, '背景');
  p.config.sections.splice(1, 1); p = await backend.saveConfig({ config: p.config, version: p.version });
  assert.equal(p.config.sections.length, 1); assert.equal(await fs.readFile(path.join(root, method.path), 'utf8'), '# 方法\n\n');
  await assert.rejects(backend.createSection({ title: '再次', path: intro.path }), e => e.code === 'EXISTS');
  await backend.saveFile({ path: 'content-existing.md', content: '# 已有正文\n不可覆盖\n', version: null });
  await assert.rejects(backend.createSection({ title: '已有', path: 'content-existing.md', content: '# 覆盖' }), e => e.code === 'CONFLICT');
  p = await backend.createSection({ title: '已有', path: 'content-existing.md' });
  assert.equal(p.config.sections.at(-1).path, 'content-existing.md');
  assert.match((await backend.readFile('content-existing.md')).content, /不可覆盖/);
});

test('paper and patent presets remain editable templates rather than mandatory section requirements', async t => {
  const { root, backend } = await fixture(t, { kind: 'paper' });
  let p = await backend.getProject(); assert.equal(p.config.sections.length, 8); assert.equal(p.config.sections[0].title, '摘要');
  const other = path.join(root, 'patent'); p = await backend.createProject(other, { kind: 'patent', title: '发明' });
  assert.equal(p.title, '发明'); assert.ok(p.config.sections.some(s => s.title === '权利要求书'));
  p.config.sections = []; p = await backend.saveConfig({ config: p.config, version: p.version }); assert.deepEqual(p.config.sections, []);
});

test('blank document builds before a complete skeleton exists and new content updates only on explicit build', async t => {
  const { root, backend, events } = await fixture(t, { kind: 'blank' });
  const first = await backend.build();
  await waitFor(() => backend.getJob(first.jobId).status === 'completed', 'Blank document should produce an editable preview.');
  assert.equal(backend.getJob(first.jobId).stats.renderedSections, 0);
  const p = await backend.createSection({ title: '第一章', content: '# 第一章\n正文\n' });
  const second = await backend.build();
  await waitFor(() => backend.getJob(second.jobId).status === 'completed');
  assert.equal(backend.getJob(second.jobId).stats.renderedSections, 1);
  const preview = await fs.readFile(backend.getJob(second.jobId).htmlPath, 'utf8'); assert.match(preview, /正文/);
  const count = backend.jobs.size; events.length = 0;
  await fs.writeFile(path.join(root, p.config.sections[0].path), '# 第一章\nAI 修改\n');
  await waitFor(() => events.find(e => e.type === 'files-changed'));
  assert.equal(backend.jobs.size, count); assert.equal((await backend.getProject()).latestPreview.jobId, second.jobId);
});

test('external text and manifest changes refresh automatically without starting a build', async t => {
  const { root, backend, events } = await fixture(t);
  const p = await backend.getProject(); const section = p.config.sections[0];
  await fs.writeFile(path.join(root, section.path), '# 外部改动\n');
  await waitFor(() => events.find(e => e.type === 'files-changed' && e.paths.includes(section.path)));
  assert.equal((await backend.readFile(section.path)).content, '# 外部改动\n'); assert.equal(backend.jobs.size, 0);
  p.config.title = '外部改名'; p.config.sections[0].title = '修改后的骨架';
  await fs.writeFile(path.join(root, 'doconstruct.json'), JSON.stringify(p.config));
  await waitFor(() => events.find(e => e.type === 'files-changed' && e.project?.title === '外部改名'));
  assert.equal((await backend.getProject()).config.sections[0].title, '修改后的骨架'); assert.equal(backend.jobs.size, 0);
});

test('editor own saves are not repeated as external changes and conflicts preserve external bytes', async t => {
  const { root, backend, events } = await fixture(t);
  const source = await backend.readFile('sections/01-introduction.md');
  await backend.saveFile({ ...source, content: '# 自己保存\n' }); await delay(180);
  assert.equal(events.filter(e => e.type === 'files-changed').length, 0);
  const opened = await backend.readFile(source.path); await fs.writeFile(path.join(root, source.path), '# 别的编辑器\n');
  await waitFor(() => events.find(e => e.type === 'files-changed'));
  await assert.rejects(backend.saveFile({ ...opened, content: '# 不能覆盖\n' }), e => e.code === 'CONFLICT');
  assert.equal(await fs.readFile(path.join(root, source.path), 'utf8'), '# 别的编辑器\n');
});

test('external directory replacement resumes watchers and project switches suppress old notifications', async t => {
  const { root, backend, events } = await fixture(t);
  await fs.rename(path.join(root, 'sections'), path.join(root, 'old-sections'));
  await fs.mkdir(path.join(root, 'sections')); await fs.writeFile(path.join(root, 'sections/01-introduction.md'), '# 新目录\n');
  await fs.copyFile(path.join(root, 'old-sections/02-details.md'), path.join(root, 'sections/02-details.md'));
  await waitFor(() => events.find(e => e.type === 'files-changed' && e.paths.includes('sections/01-introduction.md')));
  events.length = 0; await fs.writeFile(path.join(root, 'sections/01-introduction.md'), '# 再次修改\n');
  await waitFor(() => events.find(e => e.type === 'files-changed'));
  const other = path.join(root, 'other'); await backend.createProject(other, { kind: 'blank' }); events.length = 0;
  await fs.writeFile(path.join(root, 'sections/01-introduction.md'), '# 旧项目\n'); await delay(180);
  assert.equal(events.filter(e => e.type === 'files-changed').length, 0);
});

test('lazy file tree includes resources, watches expanded asset folders, blocks linked escapes', async t => {
  const { root, backend, events } = await fixture(t);
  await fs.mkdir(path.join(root, 'assets')); await fs.writeFile(path.join(root, 'assets/plot.png'), Buffer.from([137, 80, 78, 71]));
  await fs.mkdir(path.join(root, 'node_modules')); await fs.writeFile(path.join(root, 'node_modules/ignored.txt'), 'skip');
  const listed = await backend.listDirectory(); assert.ok(listed.entries.some(e => e.name === 'assets')); assert.ok(!listed.entries.some(e => e.name === 'node_modules'));
  const assets = await backend.listDirectory({ path: 'assets' }); assert.equal(assets.entries[0].extension, '.png'); assert.equal(assets.entries[0].size, 4);
  await assert.rejects(backend.readFile('assets/plot.png'), e => e.code === 'BINARY');
  await fs.writeFile(path.join(root, 'assets/binary.data'), Buffer.from([0xff, 0xfe, 0]));
  await assert.rejects(backend.readFile('assets/binary.data'), e => e.code === 'BINARY');
  await fs.writeFile(path.join(root, 'assets/plain.custom'), '中文 UTF-8 正文');
  assert.equal((await backend.readFile('assets/plain.custom')).content, '中文 UTF-8 正文');
  events.length = 0; await fs.writeFile(path.join(root, 'assets/new.svg'), '<svg/>');
  await waitFor(() => events.find(e => e.type === 'files-changed' && e.paths.includes('assets/new.svg')));
  assert.ok((await backend.listDirectory({ path: 'assets' })).entries.some(e => e.name === 'new.svg'));
  await assert.rejects(backend.listDirectory({ path: '../' }), e => e.code === 'PATH');
  await fs.mkdir(path.join(root, 'assets/folder.md'));
  assert.ok((await backend.listDirectory({ path: 'assets' })).entries.some(e => e.path === 'assets/folder.md' && e.type === 'directory'));
});

test('expanded root tree ignores atomic-save temporary files and does not supersede the next explicit build', async t => {
  const { backend, events } = await fixture(t);
  await backend.listDirectory();
  const css = await backend.readFile('layout.css');
  await backend.saveFile({ ...css, content: css.content + '\np { color: black; }\n' });
  const started = await backend.build();
  await waitFor(() => ['completed', 'failed', 'superseded'].includes(backend.getJob(started.jobId).status));
  assert.equal(backend.getJob(started.jobId).status, 'completed');
  await delay(180); assert.equal(events.filter(e => e.type === 'files-changed').length, 0);
  assert.equal((await backend.getProject()).latestPreview.jobId, started.jobId);
});

test('tree file and directory rename keeps section/layout references, delete moves source to trash', async t => {
  const { root, backend } = await fixture(t);
  await backend.createDirectory({ path: 'assets' });
  let p = await backend.renameEntry({ path: 'sections', newPath: 'assets/text' });
  assert.ok(p.config.sections.every(s => s.path.startsWith('assets/text/')));
  p = await backend.renameEntry({ path: 'layout.css', newPath: 'styles/theme.css' }); assert.equal(p.config.stylesheet, 'styles/theme.css');
  await assert.rejects(backend.removeEntry({ path: 'styles' }), e => e.code === 'PATH');
  await assert.rejects(backend.renameEntry({ path: 'layout.py', newPath: 'doconstruct.json' }), e => e.code === 'PATH');
  await assert.rejects(backend.removeEntry({ path: 'doconstruct.json' }), e => e.code === 'PATH');
  const text = await fs.readFile(path.join(root, p.config.sections[0].path), 'utf8');
  const removed = await backend.removeEntry({ path: p.config.sections[0].path });
  assert.equal(removed.project.config.sections.length, 1); assert.equal(await fs.readFile(path.join(root, removed.trashPath), 'utf8'), text);
  assert.ok(!(await backend.listDirectory()).entries.some(e => e.name === '.doconstruct'));
  assert.equal(backend.jobs.size, 0);
});
