const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePermissions, pathAllowed, toolAllowed } = require('../src/ai/permissions.cjs');

test('permissions retain explicit empty scope and default without mutating configuration', () => {
  const defaults = { readFiles: false, allowedPaths: ['content/'] };
  const input = { writeFiles: false, allowedPaths: [] };
  const p = normalizePermissions(input, defaults);
  assert.deepEqual(p, { readFiles: false, writeFiles: false, allowCommands: false, allowedPaths: [] });
  assert.deepEqual(defaults, { readFiles: false, allowedPaths: ['content/'] });
  assert.deepEqual(input, { writeFiles: false, allowedPaths: [] });
  assert.equal(pathAllowed('content/a.md', p), false);
  assert.equal(pathAllowed('', p, { navigation: true }), false);
  assert.deepEqual(normalizePermissions(), { readFiles: true, writeFiles: true, allowCommands: false, allowedPaths: ['.'] });
});

test('scope normalization and directory navigation honor whole path boundaries', () => {
  const p = normalizePermissions({ allowedPaths: ['./content\\chapters///', 'assets/plot.svg', 'CONTENT/CHAPTERS'] });
  assert.deepEqual(p.allowedPaths, ['content/chapters', 'assets/plot.svg']);
  assert.equal(pathAllowed('content/chapters/a.md', p), true);
  assert.equal(pathAllowed('CONTENT/CHAPTERS/A.md', p), true);
  assert.equal(pathAllowed('content/chapters-other/a.md', p), false);
  assert.equal(pathAllowed('content', p), false);
  assert.equal(pathAllowed('content', p, { navigation: true }), true);
  assert.equal(pathAllowed('', p, { navigation: true }), true);
  assert.equal(pathAllowed('assets/plot.svg', p), true);
  assert.equal(pathAllowed('assets/plot.svg.bak', p), false);
  assert.equal(pathAllowed('secrets', p, { navigation: true }), false);
});

test('absolute, traversal, drive and NUL scopes are rejected and cannot authorize queries', () => {
  const p = normalizePermissions();
  for (const value of ['', '/etc', '\\Windows', '\\\\server\\share', 'C:/work', 'C:relative', '../other', 'content/../other', 'a\0b', 'doc.md:stream'])
    assert.throws(() => normalizePermissions({ allowedPaths: [value] }), e => e.code === 'AI_PERMISSIONS', value);
  for (const value of ['/etc', 'C:/work', '../other', 'content/../other', 'a\0b', null, 5]) assert.equal(pathAllowed(value, p), false);
  for (const key of ['readFiles', 'writeFiles', 'allowCommands']) assert.throws(() => normalizePermissions({ [key]: 'true' }), e => e.code === 'AI_PERMISSIONS');
});

test('command access requires unrestricted file access and never silently broadens the scope', () => {
  for (const input of [
    { allowCommands: true, allowedPaths: ['content'] },
    { allowCommands: true, allowedPaths: [] },
    { allowCommands: true, readFiles: false },
    { allowCommands: true, writeFiles: false }
  ]) assert.throws(() => normalizePermissions(input), e => e.code === 'AI_PERMISSIONS');
  const p = normalizePermissions({ allowCommands: true });
  assert.equal(toolAllowed('run_project_command', p), true);
  assert.equal(toolAllowed('run_shell_command', p), true);
  assert.equal(toolAllowed('run_shell_command', { ...p, allowedPaths: ['content'] }), false);
  assert.equal(toolAllowed('run_shell_command', { ...p, writeFiles: false }), false);
});

test('tool categories distinguish metadata, reads, writes and local command execution', () => {
  const p = normalizePermissions({ readFiles: false, writeFiles: false, allowedPaths: [] });
  assert.equal(toolAllowed('inspect_project', p), true);
  for (const name of ['list_files', 'read_file', 'validate_project', 'write_file', 'update_outline', 'run_project_command', 'run_shell_command', 'unknown_tool'])
    assert.equal(toolAllowed(name, p), false, name);
  const readonly = normalizePermissions({ writeFiles: false });
  assert.equal(toolAllowed('read_file', readonly), true);
  assert.equal(toolAllowed('write_file', readonly), false);
});
